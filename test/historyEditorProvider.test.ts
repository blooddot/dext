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
vi.mock("../src/platform/vscode/theme.js", () => ({ loadEditorTokenTheme: () => undefined }));
vi.mock("../src/platform/vscode/contextHost.js", () => ({ openDextFileReference: vi.fn() }));

import { DextHistoryPanel } from "../src/features/conversations/host/historyEditorProvider.js";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { MemoryHistoryBackend } from "./historyBackend.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import type { DextStorage } from "../src/platform/vscode/dextStorage.js";

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
  history = new DextHistoryStore(new MemoryHistoryBackend());
  await history.addSuccess("question", [], { kind: "workflow", executions: [] }, "session-1", "ask", "turn-1");
  panel = new DextHistoryPanel({} as VSCode.Uri, history, new DextConversationPreferences(memory), {} as DextStorage);
  await panel.showInActiveEditor();
});

describe("History turn action routing", () => {
  it.each(["openTurnDiff", "renameTurn", "forkFromTurn", "copyTurn", "openSpill", "deleteTurn"])("routes %s with the clicked turn and session", (action) => {
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
    await vi.waitFor(() => expect(state.post).toHaveBeenCalledWith({
      type: "historySessionBody", sessionId: "session-1",
      html: expect.stringContaining('class="output-turn-title"><span class="output-turn-title-name">New title</span>')
    }));
    expect(state.post).toHaveBeenCalledWith(expect.objectContaining({ html: expect.stringContaining('data-history-command="dext.history.copyTurn"') }));
  });

  it("updates just the renamed turn's label and leaves the document intact", async () => {
    const html = state.html;
    await history.renameTurn("session-1", "turn-1", "Renamed");
    await panel.refreshTurnTitle("session-1", "turn-1");
    expect(state.html).toBe(html);
    expect(state.post).toHaveBeenCalledExactlyOnceWith({
      type: "historyTurnTitle", sessionId: "session-1", turnId: "turn-1", title: "Renamed", named: true
    });
  });

  it("forwards a toolbar click without toggling the row and changes only the matching label", () => {
    const clickListeners = new Map<string, (event: unknown) => void>();
    const windowListeners = new Map<string, (event: unknown) => void>();
    const postMessage = vi.fn();
    const label = { textContent: "question", hidden: true };
    const title = { querySelector: () => label };
    const siblingLabel = { textContent: "sibling" };
    const rows = [
      { dataset: { sessionId: "session-1", turnId: "turn-1" }, querySelector: () => title },
      { dataset: { sessionId: "session-1", turnId: "turn-2" }, querySelector: () => ({ querySelector: () => siblingLabel }) }
    ];
    class Element {
      dataset = { historyCommand: "dext.history.copyTurn", sessionId: "session-1", turnId: "turn-1" };
      closest(selector: string) { return selector === "[data-history-command]" ? this : null; }
    }
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(state.html)![1]!;
    class Details {}
    const moved = { label: "actions" };
    const bodyTarget = { append: vi.fn() };
    const summaryTarget = { append: vi.fn() };
    const record = Object.assign(new Details(), {
      classList: { contains: (name: string) => name === "history-record" },
      open: true,
      querySelector: (selector: string) => selector.includes("history-turn-actions") ? moved
        : selector.includes("history-record-body") ? bodyTarget : summaryTarget
    });
    runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage }), Element, HTMLDetailsElement: Details,
      document: {
        addEventListener: (type: string, callback: (event: unknown) => void) => clickListeners.set(type, callback),
        querySelector: () => null,
        querySelectorAll: () => rows
      },
      window: { addEventListener: (type: string, callback: (event: unknown) => void) => windowListeners.set(type, callback) }
    });
    const event = { target: new Element(), preventDefault: vi.fn(), stopPropagation: vi.fn() };
    clickListeners.get("click")!(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: "historyCommand", command: "dext.history.copyTurn", sessionId: "session-1", turnId: "turn-1", path: "" });
    windowListeners.get("message")!({ data: { type: "historyTurnTitle", sessionId: "session-1", turnId: "turn-1", title: "<New title>", named: true } });
    expect(label.textContent).toBe("<New title>");
    expect(label.hidden).toBe(false);
    expect(siblingLabel.textContent).toBe("sibling");
    // An opened turn moves its toolbar out of the prompt and onto the body.
    clickListeners.get("toggle")!({ target: record });
    expect(bodyTarget.append).toHaveBeenCalledWith(moved);
    record.open = false;
    clickListeners.get("toggle")!({ target: record });
    expect(summaryTarget.append).toHaveBeenCalledWith(moved);
  });

  it("lists only conversations that recorded a turn", async () => {
    await history.updateResourceContext("empty-shell", { type: "rule", scope: "global" });
    panel.refresh();
    expect(state.html).toContain("session-1");
    expect(state.html).not.toContain("empty-shell");
  });

  it("filters rendered conversations from the search box and clears on Escape", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const row = (text: string) => ({ text, hidden: false, getAttribute: (name: string) => name === "data-history-search-text" ? text : null });
    const rows = [row("auth refactor explain a.ts"), row("release notes")];
    const input = { value: "", matches: (selector: string) => selector === "[data-history-search]" };
    const empty = { hidden: true };
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(state.html)![1]!;
    runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: () => undefined }),
      document: {
        addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
        querySelector: (selector: string) => selector === "[data-history-search]" ? input
          : selector === "[data-history-search-empty]" ? empty : null,
        querySelectorAll: (selector: string) => selector === "[data-history-search-text]" ? rows : []
      },
      window: { addEventListener: () => undefined }
    });
    input.value = "AUTH";
    listeners.get("input")!({ target: input });
    expect(rows.map((item) => item.hidden)).toEqual([false, true]);
    expect(empty.hidden).toBe(true);
    input.value = "missing";
    listeners.get("input")!({ target: input });
    expect(rows.map((item) => item.hidden)).toEqual([true, true]);
    expect(empty.hidden).toBe(false);
    listeners.get("keydown")!({ key: "Escape", target: input });
    expect(input.value).toBe("");
    expect(rows.map((item) => item.hidden)).toEqual([false, false]);
    expect(empty.hidden).toBe(true);
  });

  it("opens a changed-file row from the keyboard", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const row = { matches: (selector: string) => selector === ".output-turn-change[data-history-command]", click: vi.fn() };
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(state.html)![1]!;
    runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: () => undefined }),
      document: {
        addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback),
        querySelector: () => null,
        querySelectorAll: () => []
      },
      window: { addEventListener: () => undefined }
    });
    const event = { key: "Enter", target: row, preventDefault: vi.fn() };
    listeners.get("keydown")!(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(row.click).toHaveBeenCalledTimes(1);
    listeners.get("keydown")!({ key: " ", target: row, preventDefault: vi.fn() });
    expect(row.click).toHaveBeenCalledTimes(2);
    listeners.get("keydown")!({ key: "a", target: row, preventDefault: vi.fn() });
    expect(row.click).toHaveBeenCalledTimes(2);
  });
});
