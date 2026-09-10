import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { readHistoryResponse } from "../src/historyResponse.js";
import { presentTurn } from "../src/turnPresentation.js";
import { renderTurnInput, renderTurnResult, turnDomAdapter } from "../src/turnComponents.js";

const main = readFileSync("src/webview/main.ts", "utf8");
const renderer = ts.transpileModule([
  main.slice(main.indexOf("function finishAgentProgress("), main.indexOf("function agentEventKind(")),
  main.slice(main.indexOf("function scheduleAgentMessageRender("), main.indexOf("function renderAgentEvent(")),
  main.slice(main.indexOf("function resetAgentTrace("), main.indexOf("function renderOutputSession("))
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

class Disclosure {
  open = true;
  dataset = { turnId: "history" };
  classList = { contains: (name: string) => name === "output-turn" };
}

function harness() {
  const frames = new Map<number, () => void>();
  let nextFrame = 10;
  const liveItem = { querySelector: () => ({ isConnected: true }) };
  const turn = {
    input: { childElementCount: 0, append: vi.fn() },
    disclosure: new Disclosure(),
    processDisclosure: { open: true }, processMeta: { textContent: "" }, outputDisclosure: { open: false },
    todos: { setRunning: vi.fn() }, output: { append: vi.fn() }, hydrated: false
  };
  const record = { input: "Historical input", output: "Historical answer", process: [{ phase: "message", id: "shared", text: "Historical trace" }] };
  const activeTurn = { todos: { setRunning: vi.fn() } };
  const state = {
    activeTurn, agentStream: { live: true }, agentRunStartedAt: 100, agentRunTimer: 42,
    agentProgress: { textContent: "Thinking" }, agentProgressState: "Thinking", agentTokenUsage: { totalTokens: 300 },
    agentCommandIds: new Set(["live-command"]), agentEditedUris: new Set(["live.ts"]),
    agentEventItems: new Map<string, unknown>([["shared", liveItem]]), agentToolItems: new Map([["shared", { live: true }]]),
    agentToolGroups: new Map([["shared", { live: true }]]), agentToolGroup: { live: true }, agentFileChanges: { live: true },
    pendingAgentRenders: new Set([liveItem]), agentRenderFrame: 1,
    pendingAgentEventBatches: [{ sessionId: "session", events: [{ phase: "message", text: "live delta" }] }], agentEventBatchFrame: 2
  };
  const context = {
    readHistoryResponse, presentTurn, renderTurnInput, renderTurnResult, turnDomAdapter,
    ...state, turn, record, executing: true, activeConversationId: "session", forceInitialConversationScroll: false,
    outputTurns: new Map<string, unknown>(), HTMLDetailsElement: Disclosure,
    event: { target: turn.disclosure },
    document: { createElement: () => ({ append: vi.fn(), setAttribute: vi.fn() }) },
    renderedInputSource: vi.fn(), copyButton: vi.fn(), jsonOutput: vi.fn((text: string) => text),
    renderAgentEvent: vi.fn(), renderAgentMessageItem: vi.fn(),
    updateAgentProgress: vi.fn(), syncResultToggle: vi.fn(), syncJumpToLatest: vi.fn(),
    resultIsNearBottom: () => false, followResultIfNeeded: vi.fn(),
    requestAnimationFrame: (callback: () => void) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)), clearInterval: vi.fn()
  };
  runInNewContext(`${renderer}
    turn.hydrate = () => hydrateStoredTurn(record, turn);
    outputTurns.set('history', turn);
  `, context);
  return { context, state, turn, frames };
}

describe("expanding history while a turn is streaming", () => {
  it("renders the body of an old Agent chat result after reopening a turn", () => {
    const { context, turn } = harness();
    context.record.output = JSON.stringify({ kind: "workflow", executions: [{
      method: { id: "agent" }, result: { kind: "chat", text: "Recovered **answer**" }, durationMs: 1
    }] });
    const fragments: unknown[] = [];
    Object.assign(context, {
      document: {
        ...context.document,
        createDocumentFragment: () => ({ append: (...nodes: unknown[]) => fragments.push(...nodes) })
      },
      copyableText: (text: string) => text,
      terminalBlock: vi.fn(), fileChangeDisclosure: vi.fn(), planActions: vi.fn(),
      renderResult: (response: { executions: unknown[] }) => {
        const code = main.slice(main.indexOf("function renderExecution("), main.indexOf("function patchReviewHeader("));
        runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
          + "\nrenderExecution(execution);", { ...context, execution: response.executions[0] });
      }
    });
    runInNewContext("hydrateOutputTurnOnOpen(event)", context);
    expect(fragments).toEqual(["Recovered **answer**"]);
    expect(turn.processMeta.textContent).toBe("Worked for 1ms");
    expect(turn.hydrated).toBe(true);
  });

  it("hydrates Input, Process and Output immediately and preserves all live state", () => {
    const { context, state, turn } = harness();
    context.renderAgentEvent.mockImplementation(() => { context.agentStream = { live: false }; });
    runInNewContext("hydrateOutputTurnOnOpen(event)", context);
    expect(turn.hydrated).toBe(true);
    expect(context.renderedInputSource).toHaveBeenCalledWith("Historical input");
    expect(context.renderAgentEvent).toHaveBeenCalledWith(context.record.process[0]);
    expect(turn.output.append).toHaveBeenCalledWith("Historical answer");
    expect(turn.processDisclosure.open).toBe(false);
    expect(turn.outputDisclosure.open).toBe(true);
    for (const key of Object.keys(state) as Array<keyof typeof state>) expect(context[key], key).toBe(state[key]);
    expect(context.clearInterval).not.toHaveBeenCalled();
    expect(context.cancelAnimationFrame).not.toHaveBeenCalledWith(1);
    expect(context.cancelAnimationFrame).not.toHaveBeenCalledWith(2);
    expect(state.activeTurn.todos.setRunning).not.toHaveBeenCalled();
    runInNewContext("hydrateOutputTurnOnOpen(event)", context);
    expect(context.renderedInputSource).toHaveBeenCalledOnce();
  });

  it("isolates colliding event IDs and paints history without losing queued live messages", () => {
    const { context, state } = harness();
    runInNewContext(`
      historyItem = { querySelector: () => ({ isConnected: true }) };
      withIsolatedAgentTrace(turn, () => {
        if (agentEventItems.has('shared') || agentToolItems.has('shared') || agentToolGroups.has('shared')) throw new Error('Shared trace');
        agentEventItems.set('shared', historyItem);
        scheduleAgentMessageRender(historyItem);
      });
    `, context);
    expect(context.renderAgentMessageItem).toHaveBeenCalledOnce();
    expect(state.pendingAgentRenders.size).toBe(1);
    expect(state.pendingAgentEventBatches).toHaveLength(1);
    runInNewContext("flushAgentMessageRenders(); flushAgentEventBatches();", context);
    expect(context.renderAgentMessageItem).toHaveBeenCalledTimes(2);
    expect(context.renderAgentEvent).toHaveBeenCalledWith({ phase: "message", text: "live delta" });
    expect(context.activeTurn).toBe(state.activeTurn);
    expect(context.agentEventItems).toBe(state.agentEventItems);
  });

  it("restores the stream after a history rendering error and allows another attempt", () => {
    const { context, state, turn } = harness();
    context.renderedInputSource.mockImplementationOnce(() => { throw new Error("Render failed"); });
    expect(() => { runInNewContext("hydrateOutputTurnOnOpen(event)", context); }).toThrow("Render failed");
    expect(turn.hydrated).toBe(false);
    for (const key of Object.keys(state) as Array<keyof typeof state>) expect(context[key], key).toBe(state[key]);
    runInNewContext("hydrateOutputTurnOnOpen(event)", context);
    expect(turn.hydrated).toBe(true);
  });
});

it("hydrates unknown historical results as read-only output without dispatching an interaction", () => {
  const { context, state } = harness();
  const response = { kind: "workflow", executions: [{ method: { id: "ui.choose" }, result: { kind: "ui", type: "choice", selected: ["old"] } }] };
  context.record.output = JSON.stringify(response);
  const renderResult = vi.fn(); Object.assign(context, { renderResult });
  runInNewContext("hydrateOutputTurnOnOpen(event)", context);
  expect(renderResult).toHaveBeenCalledWith(response);
  expect(context.renderAgentEvent).toHaveBeenCalledTimes(1);
  expect(context.activeTurn).toBe(state.activeTurn);
});
