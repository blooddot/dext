import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { Disposable, ExtensionContext, Uri } from "vscode";
import type { DextSidebarProvider } from "../src/app/sidebarProvider.js";
import { activate, deactivate } from "../src/extension.js";
import type { AgentSelection } from "../src/features/agents/contracts/agent.js";
import { openFileHistoryStore } from "../src/features/conversations/host/historyFileState.js";
import type { WebviewResponse } from "../src/platform/webviewProtocol.js";
import { createConversationHarness, defaultSelection } from "./conversationHarness.js";

const host = vi.hoisted(() => ({
  commands: new Map<string, (context: unknown) => Promise<void>>(),
  executeCommand: vi.fn().mockResolvedValue(undefined),
  registerWebviewViewProvider: vi.fn(),
  showErrorMessage: vi.fn().mockResolvedValue(undefined)
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
    window: {
      registerWebviewViewProvider: host.registerWebviewViewProvider.mockImplementation(subscribe),
      registerWebviewPanelSerializer: subscribe,
      onDidChangeActiveColorTheme: subscribe,
      onDidChangeTextEditorSelection: subscribe,
      onDidChangeActiveTextEditor: subscribe,
      onDidChangeWindowState: subscribe,
      showErrorMessage: host.showErrorMessage
    },
    workspace: {
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
