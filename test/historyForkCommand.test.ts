import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { Disposable, ExtensionContext, Uri } from "vscode";
import type { DextSidebarProvider } from "../src/app/sidebarProvider.js";
import { activate, deactivate } from "../src/extension.js";
import type { AgentSelection } from "../src/features/agents/contracts/agent.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import { openFileHistoryStore } from "../src/features/conversations/host/historyFileState.js";
import { renderHistoryRecord } from "../src/features/conversations/presentation/historyRender.js";
import { TURN_RETRY_CONFIRMATION } from "../src/features/conversations/presentation/turnPresentation.js";
import type { WebviewResponse } from "../src/platform/webviewProtocol.js";
import { DextKernelHost } from "../src/runner/dextHost.js";
import type { ExecutionMetadata, InputExecutionResponse, InvocationAst, RuntimeResponse } from "../src/shared/contracts/types.js";
import { createConversationHarness, defaultSelection } from "./conversationHarness.js";

const host = vi.hoisted(() => ({
  commands: new Map<string, (context: unknown) => Promise<void>>(),
  executeCommand: vi.fn().mockResolvedValue(undefined),
  registerWebviewViewProvider: vi.fn(),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  /** The Host API boundary of the Code run these tests exercise. */
  executeInput: vi.fn<(source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse>>()
}));

vi.mock("vscode", () => {
  const subscribe = () => ({ dispose() {} });
  return {
    Uri: { joinPath: (base: Uri, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }) },
    commands: {
      executeCommand: host.executeCommand,
      registerCommand: (id: string, command: (context: unknown) => Promise<void>) => {
        host.commands.set(id, command);
        return { dispose: () => { host.commands.delete(id); } };
      }
    },
    extensions: { getExtension: () => undefined },
    window: {
      showWarningMessage: host.showWarningMessage,
      registerWebviewViewProvider: host.registerWebviewViewProvider.mockImplementation(subscribe),
      registerWebviewPanelSerializer: subscribe,
      onDidChangeActiveColorTheme: subscribe,
      onDidChangeTextEditorSelection: subscribe,
      onDidChangeActiveTextEditor: subscribe,
      onDidChangeWindowState: subscribe,
      showErrorMessage: host.showErrorMessage
    },
    workspace: {
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      isTrusted: true,
      onDidChangeConfiguration: subscribe,
      onDidGrantWorkspaceTrust: subscribe,
      onDidChangeTextDocument: subscribe,
      onDidChangeWorkspaceFolders: subscribe,
      createFileSystemWatcher: () => ({ ...subscribe(), onDidCreate: subscribe, onDidChange: subscribe, onDidDelete: subscribe })
    },
    languages: { registerHoverProvider: subscribe }
  };
});

vi.mock("../src/features/conversations/host/historyFileState.js", () => ({ openFileHistoryStore: vi.fn() }));
vi.mock("../src/app/application.js", () => ({
  DextApplication: class {
    private selection: AgentSelection = { ...defaultSelection, skillLoading: "every-turn", skills: ["source-skill"] };
    readonly agents = { currentSelection: () => this.selection };
    readonly runtime = { setWorkspaceTrusted() {} };
    readonly storage = { globalStorageUri: { fsPath: process.cwd() } };
    configurePiRuntime() {}
    configureVideoFrames() {}
    async reload() {}
    async dispose() {}
    setApiFlowAnalyzer() {}
    invalidAgentCliIds() { return []; }
    state() { return { agentSelection: this.selection }; }
    setAgentSelection(selection: AgentSelection) { this.selection = selection; }
    agentProfiles(): [] { return []; }
    executeInput(source: string, metadata: Readonly<ExecutionMetadata>) { return host.executeInput(source, metadata); }
  }
}));

it.each([
  { command: "dext.history.forkConversation", inputs: ["first prompt", "second prompt"] },
  { command: "dext.history.forkFromTurn", inputs: ["first prompt"] }
])("opens the saved branch and retries its selection after a write failure in $command", async ({ command, inputs }) => {
  const { history, state, preferences } = createConversationHarness();
  const response = { kind: "workflow" as const, executions: [] };
  await history.addSuccess("first prompt", [], response, "source", "agent", "first");
  await history.addSuccess("second prompt", [], response, "source", "agent", "second");
  await history.setProviderSession("source", "codex", "provider-session");
  await preferences.setTitle("source", "Source title");
  const update = state.update.bind(state);
  const selectionWrites = vi.fn().mockRejectedValueOnce(new Error("Temporary preference write failure"));
  vi.spyOn(state, "update").mockImplementation(async (key, value) => {
    if (key === "dext.conversationSelections") await selectionWrites(value);
    await update(key, value);
  });
  vi.mocked(openFileHistoryStore).mockResolvedValue(history);
  host.registerWebviewViewProvider.mockClear();
  host.executeCommand.mockClear();
  host.showErrorMessage.mockClear();
  const subscriptions: Disposable[] = [];
  const uri = { fsPath: process.cwd() };
  try {
    await activate({ globalStorageUri: uri, extensionUri: uri, globalState: state, workspaceState: state, subscriptions } as unknown as ExtensionContext);
    const sidebar = host.registerWebviewViewProvider.mock.calls[0]?.[1] as DextSidebarProvider;
    const post = vi.spyOn(sidebar as unknown as { post(message: WebviewResponse): Promise<void> }, "post");
    await host.commands.get(command)!({ sessionId: "source", turnId: "first" });

    const sessions = await history.sessions();
    expect(sessions).toHaveLength(2);
    const fork = sessions.find((session) => session.id !== "source")!;
    expect(fork.turns.map((turn) => turn.input)).toEqual(inputs);
    expect(fork.forkProviderSessions).toEqual({ codex: "provider-session" });
    expect(host.showErrorMessage).not.toHaveBeenCalled();
    expect(host.executeCommand).toHaveBeenCalledWith("dext.sidebar.focus");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: "activeConversation", activeId: fork.id, selection: { ...defaultSelection, skillLoading: "on-demand" }
    }));
    expect(preferences.title(fork.id)).toBe("Source title (fork)");
    expect(preferences.conversationSelection(fork.id)).toBeUndefined();

    const reloaded = createConversationHarness({
      state,
      layout: { openConversationIds: ["source", fork.id], activeConversationId: fork.id }
    });
    try {
      await reloaded.seed(sessions);
      expect(reloaded.controller.active().id).toBe(fork.id);
      expect(reloaded.controller.selection(fork.id)).toEqual({ ...defaultSelection, skillLoading: "on-demand" });
    } finally {
      reloaded.dispose();
    }

    const reopen = host.commands.get("dext.history.continueConversation")!;
    await Promise.all([reopen({ sessionId: fork.id }), reopen({ sessionId: fork.id })]);
    expect(selectionWrites.mock.calls).toEqual([
      [{ [fork.id]: { ...defaultSelection, skillLoading: "on-demand" } }],
      [{ [fork.id]: { ...defaultSelection, skillLoading: "on-demand" } }]
    ]);
    expect(preferences.conversationSelection(fork.id)?.skillLoading).toBe("on-demand");
    expect(await history.sessions()).toHaveLength(2);
  } finally {
    for (const subscription of subscriptions.reverse()) subscription.dispose();
    await deactivate();
  }
});

/** A Code script that succeeds once, leaves visible output, then fails. Retrying
 * it starts over, so the same call asks the Host API again. */
const RETRY_SOURCE = [
  'import { ask } from "dext";',
  'const answer = await ask({ input: "scope" });',
  'console.log(`downstream: ${answer.text}`);',
  'throw new Error("script failed after the first answer");'
].join("\n");

it("retries a failed Code turn from the confirmed History command", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "dext-retry-command-"));
  /** What the Host API hands the script on each call, in call order. */
  const answers = ["first answer", "second answer"];
  const calls: string[] = [];
  const kernel = new DextKernelHost({
    workspaceRoot: root,
    runnerDirectory: resolve("src", "runner"),
    execute: async (invocation: InvocationAst): Promise<RuntimeResponse> => {
      const text = answers[calls.length] ?? "later answer";
      calls.push(text);
      return {
        invocation,
        method: { id: invocation.method, title: invocation.method, kind: "command", source: "builtin" },
        result: { kind: "ask", text },
        durationMs: 0
      };
    }
  });
  const { history, state } = createConversationHarness();
  await history.addSuccess("earlier prompt", [], { kind: "workflow", executions: [] }, "source", "agent", "earlier");
  await new DextConversationPreferences(state as never).setConversationLayout({
    openConversationIds: ["source"], activeConversationId: "source"
  });
  vi.mocked(openFileHistoryStore).mockResolvedValue(history);
  host.registerWebviewViewProvider.mockClear();
  host.executeCommand.mockClear();
  host.showErrorMessage.mockClear();
  host.showWarningMessage.mockClear();
  const subscriptions: Disposable[] = [];
  const uri = { fsPath: process.cwd() };
  try {
    host.executeInput.mockImplementation(async (source: string, metadata: Readonly<ExecutionMetadata>) =>
      kernel.runSource(source, { execution: metadata, ...(metadata.signal ? { signal: metadata.signal } : {}) }));
    await activate({ globalStorageUri: uri, extensionUri: uri, globalState: state, workspaceState: state, subscriptions } as unknown as ExtensionContext);
    const sidebar = host.registerWebviewViewProvider.mock.calls[0]?.[1] as DextSidebarProvider;
    const internals = sidebar as unknown as {
      conversation: { controller: { hydrate(): Promise<void> } };
      receive(message: unknown): Promise<void>;
    };
    await internals.conversation.controller.hydrate();
    await internals.receive({ type: "executeInput", mode: "code", source: RETRY_SOURCE, sessionId: "source" });

    const original = (await history.session("source"))!.turns[1]!;
    expect(original.mode).toBe("code");
    expect(original.error).toContain("script failed after the first answer");
    // The failure keeps what the user could already see: the call succeeded, so
    // its own step is quiet, and the printed line stays in the turn output.
    expect(original.response?.steps?.map((step) => step.method)).toEqual(["stdout"]);
    expect(original.response?.steps?.[0]?.stream?.text).toBe("downstream: first answer\n");
    expect(calls).toEqual(["first answer"]);

    // Closing the confirmation runs nothing and records no turn.
    host.showWarningMessage.mockResolvedValueOnce(undefined);
    await host.commands.get("dext.history.retryTurn")!({ sessionId: "source", turnId: original.id });
    expect(host.showWarningMessage).toHaveBeenCalledWith(TURN_RETRY_CONFIRMATION, { modal: true }, "Retry");
    expect(calls).toEqual(["first answer"]);
    expect((await history.session("source"))!.turns).toHaveLength(2);

    // Confirming reruns the script from the start: the call happens again and the
    // script continues with this attempt's response.
    host.showWarningMessage.mockResolvedValueOnce("Retry");
    await host.commands.get("dext.history.retryTurn")!({ sessionId: "source", turnId: original.id });
    expect(calls).toEqual(["first answer", "second answer"]);
    const retried = (await history.session("source"))!;
    expect(retried.turns).toHaveLength(3);
    const rerun = retried.turns[2]!;
    expect(rerun.id).not.toBe(original.id);
    expect(rerun.mode).toBe("code");
    expect(rerun.response?.steps?.[0]?.stream?.text).toBe("downstream: second answer\n");
    // The failed attempt keeps its own error and output in History.
    const kept = retried.turns[1]!;
    expect(kept.error).toContain("script failed after the first answer");
    expect(kept.response?.steps?.[0]?.stream?.text).toBe("downstream: first answer\n");
    const html = renderHistoryRecord(kept, "source");
    expect(html).toContain("downstream: first answer");
    expect(html).toContain("script failed after the first answer");
    expect(host.showErrorMessage).not.toHaveBeenCalled();
  } finally {
    kernel.dispose();
    for (const subscription of subscriptions.reverse()) subscription.dispose();
    await deactivate();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
