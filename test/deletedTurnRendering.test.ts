import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { DextHistorySession } from "../src/historyStore.js";

const main = readFileSync("src/webview/main.ts", "utf8");
const source = [
  main.slice(main.indexOf("function conversationSignature("), main.indexOf("function cacheRenderedConversation(")),
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
  const context = {
    session: stored, renderedConversationId: stored.id, renderedConversationSignature: "",
    activeConversationId: stored.id, conversationSwitchId: 2, conversationRenderGeneration: 0,
    executing: false, activeExecutionSessionId: undefined, activeTurnId: undefined, activeTurn: outputTurns.values().next().value,
    outputTurns, agentRunTimer: undefined, clearInterval: vi.fn(),
    conversationViewCache: new Map<string, unknown>(),
    elements: { result: { replaceChildren: vi.fn(), append: vi.fn() }, resultSection: { classList: { remove: vi.fn() } }, resultBody: { dataset: {} } },
    cacheRenderedConversation: vi.fn(), restoreCachedAgentRenders: vi.fn(), clearInputError: vi.fn(),
    finishConversationLoading: vi.fn(), syncResultToggle: vi.fn(), syncJumpToLatest: vi.fn(), scrollResultToBottom: vi.fn(),
    requestAnimationFrame: (callback: () => void) => callback(), setTimeout: (callback: () => void) => callback(),
    createOutputTurn: vi.fn((id: string) => { const turn = row(); outputTurns.set(id, turn); return turn; }),
    hydrateStoredTurn: vi.fn()
  };
  runInNewContext(`${renderer}\nrenderedConversationSignature = conversationSignature(session);`, context);
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
    expect(context.activeTurn).toBeUndefined();
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
    context.conversationViewCache.set("background", { stale: true });
    context.conversationViewCache.set("unrelated", { keep: true });
    runInNewContext("receiveSnapshot({type:'outputSession',session:{id:'background',turns:[]}})", context);
    expect(context.conversationViewCache.has("background")).toBe(false);
    expect(context.conversationViewCache.has("unrelated")).toBe(true);
    expect([...context.outputTurns.keys()]).toEqual(["active-turn"]);
    expect(context.elements.result.replaceChildren).not.toHaveBeenCalled();
  });

  it("still ignores snapshots from a superseded tab switch", () => {
    const context = harness(session(["active-turn"]), ["active-turn"]);
    context.conversationViewCache.set("background", { keep: true });
    runInNewContext("receiveSnapshot({type:'outputSession',switchId:1,session:{id:'background',turns:[]}})", context);
    expect(context.conversationViewCache.has("background")).toBe(true);
    expect(context.elements.result.replaceChildren).not.toHaveBeenCalled();
  });
});
