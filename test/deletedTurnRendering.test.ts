import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { DextHistorySession } from "../src/features/conversations/contracts/history.js";

const main = readFileSync("src/webview/main.ts", "utf8");
const browserModule = readFileSync("src/features/conversations/browser/conversationController.ts", "utf8");
const source = [
  browserModule.slice(browserModule.indexOf("export function conversationSignature("), browserModule.indexOf("/** Keep the rendered DOM")).replace("export function conversationSignature", "function conversationSignature"),
  main.slice(main.indexOf("function renderOutputSession("), main.indexOf("function findImageItem(")),
  `function receiveSnapshot(message) { ${main.slice(main.indexOf('  if (message.type === "outputSession") {'), main.indexOf('  if (message.type === "outputSessionRef") {'))} }`
].join("\n");
const renderer = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function session(ids: string[]): DextHistorySession {
  return {
    id: "session", createdAt: 1, updatedAt: 1,
    turns: ids.map((id) => ({ id, createdAt: 1, input: id, process: [], output: "Answer" }))
  };
}

function harness(stored: DextHistorySession, visibleIds: string[]) {
  const row = () => ({ disclosure: {}, hydrate: vi.fn() });
  const outputTurns = new Map(visibleIds.map((id) => [id, row()]));
  const browser: {
    renderedId: string | undefined;
    renderedSignature: string | undefined;
    activeId: string | undefined;
    switchId: number;
    renderGeneration: number;
    beginRender(): number;
    isCurrentRender(generation: number, sessionId: string): boolean;
    clearRendered(): void;
  } = {
    renderedId: stored.id,
    renderedSignature: "",
    activeId: stored.id,
    switchId: 2,
    renderGeneration: 0,
    beginRender(): number { return ++this.renderGeneration; },
    isCurrentRender(generation: number, sessionId: string): boolean {
      return generation === this.renderGeneration && this.activeId === sessionId && this.renderedId === sessionId;
    },
    clearRendered(): void { this.renderedId = undefined; this.renderedSignature = undefined; }
  };
  const views = new Map<string, unknown>();
  const conversationViewCache = {
    get: (id: string) => views.get(id),
    has: (id: string) => views.has(id),
    put: (id: string, value: unknown) => { views.delete(id); views.set(id, value); },
    delete: (id: string) => views.delete(id),
    get size(): number { return views.size; }
  };
  const transcript = {
    active: outputTurns.values().next().value as unknown,
    get size() { return outputTurns.size; },
    keys: () => outputTurns.keys(),
    values: () => outputTurns.values(),
    entries: () => outputTurns.entries(),
    get: (id: string) => outputTurns.get(id),
    set: (id: string, value: ReturnType<typeof row>) => { outputTurns.set(id, value); },
    clear: () => { outputTurns.clear(); transcript.active = undefined; },
    create: (id: string) => { const turn = row(); outputTurns.set(id, turn); transcript.active = turn; return turn; }
  };
  const context = {
    session: stored, browser, conversationViewCache,
    executing: false, activeExecutionSessionId: undefined, activeTurnId: undefined,
    transcript,
    outputTurns, agentRunTimer: undefined, clearInterval: vi.fn(),
    elements: { result: { replaceChildren: vi.fn(), append: vi.fn() }, resultSection: { classList: { remove: vi.fn() } }, resultBody: { dataset: {} } },
    cacheRenderedConversation: vi.fn(), restoreCachedAgentRenders: vi.fn(), clearInputError: vi.fn(),
    finishConversationLoading: vi.fn(), syncResultToggle: vi.fn(), syncJumpToLatest: vi.fn(), scrollResultToBottom: vi.fn(),
    requestAnimationFrame: (callback: () => void) => callback(), setTimeout: (callback: () => void) => callback(),
    hydrateStoredTurn: vi.fn()
  };
  runInNewContext(`${renderer}\nbrowser.renderedSignature = conversationSignature(session);`, context);
  return context;
}

describe("refreshing a conversation after deletion", () => {
  it("removes a newly streamed failed turn even when deletion restores the previous historical signature", () => {
    const context = harness(session(["saved"]), ["saved", "failed-live-turn"]);
    runInNewContext("renderOutputSession(session)", context);
    expect(context.elements.result.replaceChildren).toHaveBeenCalledOnce();
    expect([...context.outputTurns.keys()]).toEqual(["saved"]);
    expect(context.hydrateStoredTurn).toHaveBeenCalledWith(context.session.turns[0], context.outputTurns.get("saved"));
    // The next refresh is still cheap once the visible row IDs match.
    runInNewContext("renderOutputSession(session)", context);
    expect(context.elements.result.replaceChildren).toHaveBeenCalledOnce();
  });

  it("clears the viewport when deleting the only newly streamed turn", () => {
    const context = harness(session([]), ["failed-live-turn"]);
    runInNewContext("renderOutputSession(session)", context);
    expect(context.elements.result.replaceChildren).toHaveBeenCalledOnce();
    expect(context.outputTurns.size).toBe(0);
    expect(context.transcript.active).toBeUndefined();
    expect(context.hydrateStoredTurn).not.toHaveBeenCalled();
  });

  it("compares identities as well as counts before reusing the visible DOM", () => {
    const context = harness(session(["kept", "last"]), ["deleted", "last"]);
    runInNewContext("renderOutputSession(session)", context);
    expect([...context.outputTurns.keys()]).toEqual(["kept", "last"]);
    expect(context.elements.result.replaceChildren).toHaveBeenCalledOnce();
  });

  it("invalidates a deleted background turn's cached view without replacing the active conversation", () => {
    const context = harness(session(["active-turn"]), ["active-turn"]);
    context.conversationViewCache.put("background", { stale: true });
    context.conversationViewCache.put("unrelated", { keep: true });
    runInNewContext("receiveSnapshot({type:'outputSession',session:{id:'background',turns:[]}})", context);
    expect(context.conversationViewCache.has("background")).toBe(false);
    expect(context.conversationViewCache.has("unrelated")).toBe(true);
    expect([...context.outputTurns.keys()]).toEqual(["active-turn"]);
    expect(context.elements.result.replaceChildren).not.toHaveBeenCalled();
  });

  it("still ignores snapshots from a superseded tab switch", () => {
    const context = harness(session(["active-turn"]), ["active-turn"]);
    context.conversationViewCache.put("background", { keep: true });
    runInNewContext("receiveSnapshot({type:'outputSession',switchId:1,session:{id:'background',turns:[]}})", context);
    expect(context.conversationViewCache.has("background")).toBe(true);
    expect(context.elements.result.replaceChildren).not.toHaveBeenCalled();
  });
});
