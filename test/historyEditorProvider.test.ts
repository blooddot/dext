import { runInNewContext } from "node:vm";
import type * as VSCode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  receive: undefined as ((message: unknown) => void) | undefined,
  execute: vi.fn(),
  post: vi.fn(),
  html: ""
}));
vi.mock("vscode", () => ({
  ViewColumn: { Active: -1 },
  Uri: { joinPath: (_: unknown, ...parts: string[]) => ({ toString: () => parts.join("/") }) },
  commands: { executeCommand: state.execute },
  window: {
    createWebviewPanel: () => ({
      onDidDispose: vi.fn(), dispose: vi.fn(),
      webview: {
        cspSource: "test:",
        asWebviewUri: (uri: unknown) => uri,
        set html(value: string) { state.html = value; },
        onDidReceiveMessage: (listener: typeof state.receive) => { state.receive = listener; },
        postMessage: state.post
      }
    })
  }
}));
vi.mock("../src/vscodeTheme.js", () => ({ loadEditorTokenTheme: () => undefined }));
vi.mock("../src/vscodeContextHost.js", () => ({ openDextFileReference: vi.fn() }));

import { DextHistoryPanel } from "../src/historyEditorProvider.js";
import { DextHistoryStore } from "../src/historyStore.js";
import { DextConversationPreferences } from "../src/conversationPreferences.js";
import type { DextStorage } from "../src/dextStorage.js";

class MemoryState {
  private values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return (this.values.get(key) as T | undefined) ?? fallback; }
  async update(key: string, value: unknown) { this.values.set(key, value); }
}

let panel: DextHistoryPanel;
let history: DextHistoryStore;
beforeEach(async () => {
  vi.clearAllMocks();
  const memory = new MemoryState() as unknown as VSCode.Memento;
  history = new DextHistoryStore(memory);
  await history.addSuccess("question", [], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
  panel = new DextHistoryPanel({} as VSCode.Uri, history, new DextConversationPreferences(memory), {} as DextStorage);
  await panel.showInActiveEditor();
});

describe("History turn action routing", () => {
  it.each(["renameTurn", "forkFromTurn", "copyTurn", "deleteTurn"])("routes %s with the clicked turn and session", (action) => {
    state.receive?.({ type: "historyCommand", command: `dext.history.${action}`, sessionId: "session-1", turnId: "turn-1" });
    expect(state.execute).toHaveBeenCalledExactlyOnceWith(`dext.history.${action}`, { sessionId: "session-1", turnId: "turn-1" });
  });

  it("rejects a missing turn target and prevents a child action from invoking a parent command", () => {
    state.receive?.({ type: "historyCommand", command: "dext.history.renameTurn", sessionId: "session-1" });
    state.receive?.({ type: "historyCommand", command: "dext.history.renameConversation", sessionId: "session-1", turnId: "turn-1" });
    state.receive?.({ type: "historyCommand", command: "unknown.command", sessionId: "session-1" });
    state.receive?.({ type: "historyCommand", command: "dext.history.editTurnInput", sessionId: "session-1", turnId: "turn-1" });
    state.receive?.({ type: "historyCommand", command: "dext.history.retryTurn", sessionId: "session-1", turnId: "turn-1" });
    expect(state.execute).not.toHaveBeenCalled();
    state.receive?.({ type: "historyCommand", command: "dext.history.renameConversation", sessionId: "session-1", turnId: "" });
    expect(state.execute).toHaveBeenCalledExactlyOnceWith("dext.history.renameConversation", { sessionId: "session-1" });
  });

  it("includes the actions and saved name when the session is expanded lazily", async () => {
    await history.renameTurn("session-1", "turn-1", "New title");
    state.receive?.({ type: "loadHistorySession", sessionId: "session-1" });
    expect(state.post).toHaveBeenCalledWith({
      type: "historySessionBody", sessionId: "session-1",
      html: expect.stringContaining('class="history-summary-input named">New title</span>')
    });
    expect(state.post).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining('data-history-command="dext.history.copyTurn"') }));
  });

  it("updates just the renamed turn's label and leaves the document intact", async () => {
    const html = state.html;
    await history.renameTurn("session-1", "turn-1", "Renamed");
    panel.refreshTurnTitle("session-1", "turn-1");
    expect(state.html).toBe(html);
    expect(state.post).toHaveBeenCalledExactlyOnceWith({
      type: "historyTurnTitle", sessionId: "session-1", turnId: "turn-1", title: "Renamed", named: true
    });
  });

  it("forwards a toolbar click without toggling the row and changes only the matching label", () => {
    const clickListeners = new Map<string, (event: unknown) => void>();
    const windowListeners = new Map<string, (event: unknown) => void>();
    const postMessage = vi.fn();
    const label = { textContent: "question", classList: { toggle: vi.fn() } };
    const siblingLabel = { textContent: "sibling" };
    const rows = [
      { dataset: { sessionId: "session-1", turnId: "turn-1" }, querySelector: () => label },
      { dataset: { sessionId: "session-1", turnId: "turn-2" }, querySelector: () => siblingLabel }
    ];
    class Element {
      dataset = { historyCommand: "dext.history.copyTurn", sessionId: "session-1", turnId: "turn-1" };
      closest(selector: string) { return selector === "button[data-history-command]" ? this : null; }
    }
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(state.html)![1]!;
    runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage }), Element,
      document: {
        addEventListener: (type: string, callback: (event: unknown) => void) => clickListeners.set(type, callback),
        querySelectorAll: () => rows
      },
      window: { addEventListener: (type: string, callback: (event: unknown) => void) => windowListeners.set(type, callback) }
    });
    const event = { target: new Element(), preventDefault: vi.fn(), stopPropagation: vi.fn() };
    clickListeners.get("click")!(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "historyCommand", command: "dext.history.copyTurn", sessionId: "session-1", turnId: "turn-1" });
    windowListeners.get("message")!({ data: { type: "historyTurnTitle", sessionId: "session-1", turnId: "turn-1", title: "<New title>", named: true } });
    expect(label.textContent).toBe("<New title>");
    expect(label.classList.toggle).toHaveBeenCalledWith("named", true);
    expect(siblingLabel.textContent).toBe("sibling");
  });
});
