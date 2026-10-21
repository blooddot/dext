import { describe, expect, it, vi } from "vitest";
import type { ExecutionMetadata, InputExecutionResponse } from "../src/core/types.js";
import type { DextHistorySession } from "../src/features/conversations/contracts/history.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { conversationTitle } from "../src/features/conversations/presentation/historyRender.js";
import type { ResourceDocument, ResourceSession, ResourceTarget } from "../src/features/resources/contracts/resourceSession.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";
import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { conversation, createConversationHarness, HarnessState, seedHistory } from "./conversationHarness.js";
import * as vscode from "vscode";

const webviewState = vi.hoisted(() => ({
  previewProvider: undefined as { provideTextDocumentContent(uri: unknown): string } | undefined,
  nextUri: 0
}));

vi.mock("vscode", () => {
  const uri = (path: string) => ({
    scheme: "file",
    path,
    fsPath: path,
    toString: () => path,
    with: () => uri(path)
  });
  return {
    Disposable: {
      from: (...items: Array<{ dispose(): void }>) => ({
        dispose: () => { for (const item of items) item.dispose(); }
      })
    },
    Uri: {
      joinPath: (base: { fsPath: string }, ...parts: string[]) => uri([base.fsPath, ...parts].join("/")),
      file: (path: string) => uri(path),
      from: ({ scheme, path }: { scheme: string; path: string }) => {
        const value = `${scheme}://${path}/${++webviewState.nextUri}`;
        return { scheme, path, fsPath: path, toString: () => value, with: () => uri(path) };
      }
    },
    workspace: {
      workspaceFolders: undefined,
      registerTextDocumentContentProvider: (
        _scheme: string,
        provider: { provideTextDocumentContent(uri: unknown): string }
      ) => {
        webviewState.previewProvider = provider;
        return { dispose: vi.fn() };
      },
      onDidCloseTextDocument: () => ({ dispose: vi.fn() }),
      openTextDocument: vi.fn()
    },
    window: {
      showQuickPick: vi.fn(),
      showTextDocument: vi.fn(),
      showInformationMessage: vi.fn(),
      createOutputChannel: () => ({ appendLine: vi.fn() })
    },
    commands: { executeCommand: vi.fn() }
  };
});

const REVIEW: ResourceDocument = { name: "review", content: "Review carefully" };

function askResponse(text: string): InputExecutionResponse {
  return { kind: "workflow", executions: [{
    invocation: { kind: "invocation", method: "ask", arguments: [], source: "chat" },
    method: { id: "ask", title: "Ask", kind: "command", source: "builtin" }, durationMs: 1,
    result: { kind: "ask", text }
  }] };
}

function storedResourceSession(resource: ResourceSession): DextHistorySession {
  return { id: "resource", createdAt: 1, updatedAt: 1, turns: [], resource };
}

interface SidebarHarnessOptions {
  draftResource?: (
    resource: ResourceSession,
    source: string,
    metadata: Readonly<ExecutionMetadata>
  ) => Promise<{ draft: ResourceDocument; response: InputExecutionResponse }>;
  saveResource?: (resource: ResourceSession) => Promise<ResourceTarget>;
}

const defaultDraftResource = async (): Promise<{ draft: ResourceDocument; response: InputExecutionResponse }> => ({
  draft: structuredClone(REVIEW),
  response: askResponse(REVIEW.content)
});
const defaultSaveResource = async (resource: ResourceSession): Promise<ResourceTarget> => ({
  ...resource.draft!,
  path: "review.md"
});

/** A real sidebar for the resource actions it still owns. The conversation
 * stack inside it is real too; only VS Code and the application are fakes. */
function createSidebarHarness(options: SidebarHarnessOptions = {}) {
  const state = new HarnessState();
  const history = new DextHistoryStore(state as never);
  const preferences = new DextConversationPreferences(state as never);
  const posted: WebviewResponse[] = [];
  const draftResource = vi.fn(options.draftResource ?? defaultDraftResource);
  const saveResource = vi.fn(options.saveResource ?? defaultSaveResource);
  const application = {
    state: () => ({
      agentSelection: { profileId: "codex", mode: "agent" },
      resourceRoots: { global: "/global", project: "/project" }
    }),
    agentProfiles: () => [],
    composerTypes: async () => ({ declaration: "", apiPaths: [], modules: [] }),
    draftResource,
    saveResource,
    reload: async () => undefined,
    setAgentSelection: () => undefined,
    endAgentSession: () => undefined,
    executeConversation: async (): Promise<InputExecutionResponse> => ({ kind: "workflow", executions: [] }),
    executeInput: async (): Promise<InputExecutionResponse> => ({ kind: "workflow", executions: [] }),
    registry: { get: () => undefined },
    isTrustedLocalWorkspace: () => false,
    planUri: () => undefined,
    storage: { globalStorageUri: { fsPath: "/global-storage" } }
  };
  const sidebar = new DextSidebarProvider(
    { fsPath: "/extension" } as unknown as vscode.Uri,
    application as never,
    history,
    preferences
  );
  const view = {
    webview: {
      options: {},
      html: "",
      cspSource: "",
      onDidReceiveMessage: vi.fn(),
      postMessage: async (message: WebviewResponse) => { posted.push(structuredClone(message)); },
      asWebviewUri: (value: unknown) => value
    },
    onDidDispose: vi.fn()
  };
  sidebar.resolveWebviewView(view as unknown as vscode.WebviewView);

  const receive = async (request: unknown): Promise<void> => {
    await (sidebar as unknown as { receive(raw: unknown): Promise<void> }).receive(request);
  };

  /** Stores the resource conversation, lets the real provider hydrate it, and
   * opens it exactly as the history list would. */
  async function seed(resource: ResourceSession): Promise<string> {
    await seedHistory(history, [storedResourceSession(resource)]);
    await receive({ type: "ready" });
    const stored = history.list()[0];
    if (!stored) throw new Error("The resource conversation was not stored.");
    await sidebar.openConversation(stored);
    return stored.id;
  }

  async function run(source: string): Promise<void> {
    await receive({ type: "executeInput", mode: "ask", source });
  }

  return { sidebar, history, posted, draftResource, saveResource, seed, receive, run };
}

describe("resource conversations", () => {
  it("opens and persists a new dedicated tab with read-only generation", async () => {
    const harness = createConversationHarness();
    harness.seed([storedResourceSession({ type: "rule", scope: "global" })]);

    const created = await harness.controller.start(false, { type: "api", scope: "project" });

    expect(created.id).not.toBe("resource");
    expect(created.resource).toEqual({ type: "api", scope: "project" });
    expect(conversationTitle(created)).toBe("New resource");
    // A resource conversation is generated in the read-only ask mode.
    expect(harness.controller.selection(created.id)?.mode).toBe("ask");
    expect(harness.history.list().find((item) => item.id === created.id)?.resource)
      .toEqual({ type: "api", scope: "project" });
  });

  it("keeps rapid new-tab requests separate while history is being persisted", async () => {
    const harness = createConversationHarness();
    let release!: () => void;
    const pendingPersistence = new Promise<void>((resolve) => { release = resolve; });
    // Hold both selections in flight so the second tab is created before the
    // first one finishes writing its layout and history.
    vi.spyOn(harness.preferences, "setConversationSelection").mockReturnValue(pendingPersistence);

    const first = harness.controller.start(false, { type: "api", scope: "project" });
    const firstId = harness.controller.active().id;
    const second = harness.controller.start(false, { type: "api", scope: "project" });
    const secondId = harness.controller.active().id;
    expect(secondId).not.toBe(firstId);
    release();
    await Promise.all([first, second]);

    expect(harness.history.list().map((session) => session.id))
      .toEqual(expect.arrayContaining([firstId, secondId]));
    // The sidebar still announces a newly started tab with outputSession, but
    // that IPC step is outside the controller. At this level only the latest
    // tab may become the current conversation after concurrent starts.
    expect(harness.messages.flatMap((message) => message.type === "conversations" ? [message.activeId] : []))
      .toEqual([secondId]);
  });

  it("records a resource turn and retains the draft across history reload", async () => {
    const harness = createConversationHarness();
    harness.seed([storedResourceSession({ type: "rule", scope: "global" })]);
    const session = harness.controller.session("resource");
    if (!session) throw new Error("The seeded resource conversation was not hydrated.");
    harness.controller.activate(session);
    harness.draftResource.mockImplementation(async () => ({
      draft: structuredClone(REVIEW),
      response: askResponse(REVIEW.content)
    }));

    await harness.coordinator.execute(session, "agent", "Create a review rule");

    expect(harness.draftResource).toHaveBeenCalledOnce();
    expect(session.turns[0]?.mode).toBe("ask");
    // Drafting never writes the resource: saving stays an explicit action.
    expect(session.resource).toMatchObject({ draft: REVIEW, saved: false });
    expect(session.resource?.target).toBeUndefined();
    expect(harness.history.list()[0]?.resource?.draft).toEqual(REVIEW);
    expect(conversationTitle(session)).toBe("review");
    // The `execution` IPC row is posted by the sidebar's notifier, which the
    // harness deliberately stubs out. The controller-owned equivalent is the
    // conversation state that the recorded turn counts in.
    const states = harness.messages.flatMap((message) => message.type === "conversations" ? [message] : []);
    expect(states.at(-1)?.sessions.find((item) => item.id === "resource")?.turnCount).toBe(1);

    const reloaded = createConversationHarness();
    reloaded.seed(harness.history.list());
    expect(reloaded.controller.session("resource")?.resource?.draft).toEqual(REVIEW);
    expect(reloaded.controller.session("resource")?.turns[0]?.mode).toBe("ask");
  });

  it("keeps background drafts attached to their original tab", async () => {
    const harness = createConversationHarness();
    harness.seed([
      storedResourceSession({ type: "rule", scope: "global" }),
      conversation("chat", [{ id: "chat-turn", createdAt: 2, input: "hello", process: [], output: "" }])
    ]);
    const resourceSession = harness.controller.session("resource");
    const chatSession = harness.controller.session("chat");
    if (!resourceSession || !chatSession) throw new Error("The seeded conversations were not hydrated.");
    harness.controller.activate(resourceSession);
    harness.draftResource.mockImplementation(async () => {
      // The user switches tabs while the background generation is still running.
      harness.controller.activate(chatSession);
      return { draft: structuredClone(REVIEW), response: askResponse(REVIEW.content) };
    });

    await harness.coordinator.execute(resourceSession, "agent", "Generate");

    expect(chatSession.resource).toBeUndefined();
    expect(chatSession.turns).toHaveLength(1);
    expect(chatSession.turns[0]?.input).toBe("hello");
    expect(resourceSession.resource?.draft?.name).toBe("review");
    expect(resourceSession.turns).toHaveLength(1);
    expect(harness.history.list().find((item) => item.id === "chat")?.resource).toBeUndefined();
    expect(harness.history.list().find((item) => item.id === "resource")?.resource?.draft?.name).toBe("review");
  });

  it("preserves the previous draft after cancellation even if the provider returns a result", async () => {
    const harness = createConversationHarness();
    harness.seed([storedResourceSession({
      type: "rule", scope: "global", draft: { name: "earlier", content: "Keep this draft" }
    })]);
    const session = harness.controller.session("resource");
    if (!session) throw new Error("The seeded resource conversation was not hydrated.");
    harness.controller.activate(session);
    harness.draftResource.mockImplementation(async () => {
      harness.coordinator.abort("resource");
      return { draft: structuredClone(REVIEW), response: askResponse(REVIEW.content) };
    });

    await harness.coordinator.execute(session, "ask", "Revise");

    expect(session.resource?.draft?.content).toBe("Keep this draft");
    expect(session.turns[0]?.error).toContain("stopped");
    expect(harness.history.list()[0]?.resource?.draft?.content).toBe("Keep this draft");
  });

  it("saves only on request, keeps the tab open, and uses the saved document for future revisions", async () => {
    const harness = createSidebarHarness();
    const sessionId = await harness.seed({ type: "rule", scope: "global" });

    await harness.run("Generate");
    expect(harness.draftResource).toHaveBeenCalledOnce();
    expect(harness.saveResource).not.toHaveBeenCalled();
    expect(harness.history.list()[0]?.resource).toMatchObject({ draft: REVIEW, saved: false });

    await harness.receive({ type: "saveResource", sessionId });
    expect(harness.saveResource).toHaveBeenCalledOnce();
    expect(harness.history.list()[0]?.resource)
      .toMatchObject({ saved: true, target: { path: "review.md", content: "Review carefully" } });
    expect(harness.history.list()[0]?.resource?.draft).toBeUndefined();
    // The saved conversation stays the active tab, so the next revision runs there.
    const states = harness.posted.flatMap((message) => message.type === "conversations" ? [message] : []);
    expect(states.at(-1)?.activeId).toBe(sessionId);

    await harness.run("Revise the saved rule");
    expect(harness.draftResource.mock.calls[1]?.[0].target?.path).toBe("review.md");
    expect(harness.history.list()[0]?.turns).toHaveLength(2);
  });

  it("makes a scope change a copy and retains the unsaved document", async () => {
    const harness = createSidebarHarness();
    const sessionId = await harness.seed({
      type: "rule",
      scope: "global",
      target: { name: "review", content: "Original", path: "review.md" },
      draft: { name: "review", content: "Revised" }
    });

    await harness.receive({ type: "resourceOptions", sessionId, resourceType: "rule", scope: "project" });

    expect(harness.history.list()[0]?.resource).toEqual({
      type: "rule", scope: "project", draft: { name: "review", content: "Revised" }
    });
    expect(harness.saveResource).not.toHaveBeenCalled();
    const contexts = harness.posted.flatMap((message) => message.type === "resourceContext" ? [message] : []);
    expect(contexts.at(-1)?.resource).toEqual({
      type: "rule", scope: "project", draft: { name: "review", content: "Revised" }
    });
  });

  it("keeps drafts on save failure and reports errors to the owning tab", async () => {
    const harness = createSidebarHarness();
    const sessionId = await harness.seed({ type: "rule", scope: "global" });
    await harness.run("Generate");
    harness.saveResource.mockRejectedValue(new Error("File changed"));

    await harness.receive({ type: "saveResource", sessionId });

    expect(harness.history.list()[0]?.resource?.draft?.content).toBe("Review carefully");
    expect(harness.posted.at(-1)).toEqual({ type: "error", sessionId, message: "File changed" });
  });

  it("retains supporting files through history, save, and destination changes", async () => {
    const files = [{ path: "rules/review-checks.md", content: "Check evidence" }];
    const harness = createSidebarHarness({
      draftResource: async () => ({
        draft: { ...structuredClone(REVIEW), files: structuredClone(files) },
        response: askResponse(REVIEW.content)
      })
    });
    const sessionId = await harness.seed({ type: "rule", scope: "global" });

    await harness.run("Generate with rules");
    expect(harness.history.list()[0]?.resource?.draft?.files).toEqual(files);

    await harness.receive({ type: "saveResource", sessionId });
    expect(harness.history.list()[0]?.resource?.target?.files).toEqual(files);

    await harness.receive({ type: "resourceOptions", sessionId, resourceType: "rule", scope: "project" });
    expect(harness.history.list()[0]?.resource?.draft?.files).toEqual(files);
    expect(harness.history.list()[0]?.resource?.target).toBeUndefined();
  });

  it("previews a selected supporting file against its saved contents", async () => {
    const harness = createSidebarHarness();
    const sessionId = await harness.seed({
      type: "rule",
      scope: "global",
      target: {
        name: "review", path: "review.md", content: "Primary",
        files: [{ path: "rules/checks.md", content: "Original checks" }]
      },
      draft: {
        name: "review", content: "Primary",
        files: [{ path: "rules/checks.md", content: "Revised checks" }]
      }
    });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: "rules/checks.md", description: "Supporting file", content: "Revised checks", previous: "Original checks"
    } as never);
    const executeCommand = vi.mocked(vscode.commands.executeCommand);
    executeCommand.mockClear();

    await harness.receive({ type: "previewResource", sessionId });

    const diff = executeCommand.mock.calls.at(-1);
    expect(diff?.[0]).toBe("vscode.diff");
    expect(diff?.[3]).toBe("rules/checks.md — Resource changes");
    const provider = webviewState.previewProvider;
    if (!provider || !diff) throw new Error("The resource preview provider was not registered.");
    expect(provider.provideTextDocumentContent(diff[1])).toBe("Original checks");
    expect(provider.provideTextDocumentContent(diff[2])).toBe("Revised checks");
  });
});
