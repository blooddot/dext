import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { readHistoryResponse } from "../src/features/conversations/domain/historyResponse.js";
import { formatTurnTokenUsage, presentTurn } from "../src/features/conversations/presentation/turnPresentation.js";
import { renderTurnInput, renderTurnResult } from "../src/features/conversations/presentation/turnComponents.js";
import { turnDomAdapter } from "../src/features/conversations/browser/turnDomAdapter.js";
import { formatDuration } from "../src/shared/lib/duration.js";
import type { AgentStreamEvent } from "../src/shared/contracts/types.js";

// The hydration path still lives in the webview entry, but its stateful parts
// (the transcript rows and the Agent trace) moved into dedicated browser
// modules. Execute the surviving source against stubs for those owners rather
// than asserting on the entry's line layout.
const main = readFileSync("src/webview/main.ts", "utf8");
const renderer = ts.transpileModule([
  main.slice(main.indexOf("function agentStreamPanel("), main.indexOf("function renderAgentEvent(")),
  main.slice(main.indexOf("function resetAgentTrace("), main.indexOf("function renderOutputSession("))
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

class Disclosure {
  open = true;
  dataset = { turnId: "history" };
  classList = { contains: (name: string) => name === "output-turn" };
}

/** The trace contract the hydration path relies on: isolation swaps every
 * per-turn map and render queue, and restore brings the live ones back. */
class TraceStub {
  eventItems = new Map<string, unknown>([["shared", "live-event"]]);
  toolItems = new Map<string, unknown>([["shared", "live-tool"]]);
  toolGroups = new Map<string, unknown>([["shared", "live-group"]]);
  queue: unknown[] = [];
  renders: unknown[] = [];
  isolate = vi.fn(() => {
    const previous = {
      eventItems: this.eventItems,
      toolItems: this.toolItems,
      toolGroups: this.toolGroups,
      queue: this.queue
    };
    this.eventItems = new Map();
    this.toolItems = new Map();
    this.toolGroups = new Map();
    this.queue = [];
    return previous;
  });
  restore = vi.fn((previous: { eventItems: Map<string, unknown>; toolItems: Map<string, unknown>; toolGroups: Map<string, unknown>; queue: unknown[] }) => {
    this.eventItems = previous.eventItems;
    this.toolItems = previous.toolItems;
    this.toolGroups = previous.toolGroups;
    this.queue = previous.queue;
  });
  reset = vi.fn(() => {
    this.eventItems.clear();
    this.toolItems.clear();
    this.toolGroups.clear();
    this.queue = [];
  });
  scheduleMessageRender = vi.fn((item: unknown) => { this.queue.push(item); });
  flushMessageRenders = vi.fn(() => {
    const queued = this.queue;
    this.queue = [];
    this.renders.push(...queued);
  });
  commandCount = () => 0;
  editedFileCount = () => 0;
}

function harness() {
  const frames = new Map<number, () => void>();
  let nextFrame = 10;
  const liveItem = { isConnected: true };
  const turn = {
    input: { childElementCount: 0, append: vi.fn() },
    disclosure: new Disclosure(),
    processDisclosure: { open: true }, processMeta: { textContent: "" }, outputDisclosure: { open: false },
    todos: { setRunning: vi.fn() }, output: { append: vi.fn() }, hydrated: false
  };
  const record = { input: "Historical input", output: "Historical answer", process: [{ phase: "message", id: "shared", text: "Historical trace" }] as AgentStreamEvent[] };
  const liveTurn = { todos: { setRunning: vi.fn() } };
  const trace = new TraceStub();
  trace.queue.push(liveItem);
  const transcript = {
    active: liveTurn,
    get: vi.fn((turnId: string) => turnId === "history" ? turn : undefined),
    renderInputSource: vi.fn(() => ({ source: "input" }))
  };
  const state = {
    agentStream: { live: true }, agentRunStartedAt: 100, agentRunTimer: 42,
    agentProgress: { textContent: "Thinking" }, agentProgressState: "Thinking", agentTokenUsage: { totalTokens: 300 },
    pendingAgentEventBatches: [{ sessionId: "session", events: [{ phase: "message", text: "live delta" }] }], agentEventBatchFrame: 2
  };
  const context = {
    readHistoryResponse, presentTurn, renderTurnInput, renderTurnResult, turnDomAdapter, formatDuration, formatTurnTokenUsage,
    ...state, turn, record, executing: true, trace, transcript,
    browser: { activeId: "session" },
    scroll: { consumeForcedInitialScroll: () => false, setFollowing: vi.fn(), pin: vi.fn() },
    elements: { result: { append: vi.fn() }, resultSection: { classList: { remove: vi.fn() } } },
    HTMLDetailsElement: Disclosure,
    event: { target: turn.disclosure },
    document: { createElement: () => ({ append: vi.fn(), setAttribute: vi.fn() }) },
    copyButton: vi.fn(), jsonOutput: vi.fn((text: string) => text),
    renderAgentEvent: vi.fn(), renderAgentMessageItem: vi.fn(),
    updateAgentProgress: vi.fn(), syncResultToggle: vi.fn(), syncJumpToLatest: vi.fn(),
    pinResultToBottom: vi.fn(), scrollResultToBottom: vi.fn(),
    requestAnimationFrame: (callback: () => void) => { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)), clearInterval: vi.fn()
  };
  runInNewContext(`${renderer}
    turn.hydrate = () => hydrateStoredTurn(record, turn);
  `, context);
  return { context, state, turn, liveTurn, liveItem, trace, transcript, frames };
}

describe("expanding history while a turn is streaming", () => {
  it("restores stored tokens without borrowing usage from the live turn", () => {
    const { context, state, turn } = harness();
    context.record.process.push({ phase: "status", text: "", usage: { totalTokens: 1_234 } });
    runInNewContext("hydrateOutputTurnOnOpen(event)", context);
    expect(turn.processMeta.textContent).toBe("1.2k tokens");
    expect(context.agentTokenUsage).toBe(state.agentTokenUsage);
  });

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
      terminalBlock: vi.fn(), patches: { fileChangeDisclosure: vi.fn() }, planActions: vi.fn(),
      renderResult: (response: { executions: unknown[] }) => {
        const code = main.slice(main.indexOf("function renderExecution("), main.indexOf("function renderResult("));
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
    const { context, state, turn, transcript, liveTurn } = harness();
    context.renderAgentEvent.mockImplementation(() => { context.agentStream = { live: false }; });
    runInNewContext("hydrateOutputTurnOnOpen(event)", context);
    expect(turn.hydrated).toBe(true);
    // The record carries no mode (legacy), so the source renderer is asked for plain text.
    expect(transcript.renderInputSource).toHaveBeenCalledWith("Historical input", undefined);
    expect(context.renderAgentEvent).toHaveBeenCalledWith(context.record.process[0]);
    expect(turn.output.append).toHaveBeenCalledWith("Historical answer");
    expect(turn.processDisclosure.open).toBe(false);
    expect(turn.outputDisclosure.open).toBe(true);
    for (const key of Object.keys(state) as Array<keyof typeof state>) expect(context[key], key).toBe(state[key]);
    expect(context.clearInterval).not.toHaveBeenCalled();
    expect(context.transcript.active).toBe(liveTurn);
    expect(state.agentStream).toBeDefined();
    runInNewContext("hydrateOutputTurnOnOpen(event)", context);
    expect(transcript.renderInputSource).toHaveBeenCalledOnce();
  });

  it("isolates colliding event IDs and paints history without losing queued live messages", () => {
    const { context, state, turn, trace, liveItem } = harness();
    runInNewContext(`
      withIsolatedAgentTrace(turn, () => {
        if (trace.eventItems.size || trace.toolItems.size || trace.toolGroups.size) throw new Error('Shared trace');
        if (trace.queue.length) throw new Error('Shared render queue');
        trace.eventItems.set('shared', 'history-event');
        trace.scheduleMessageRender({ isConnected: true });
      });
    `, context);
    expect(trace.isolate).toHaveBeenCalledOnce();
    expect(trace.restore).toHaveBeenCalledOnce();
    // Historical prose was painted inside the isolated scope.
    expect(trace.renders).toHaveLength(1);
    // The live trace and its queued message survive the replay.
    expect(trace.eventItems.get("shared")).toBe("live-event");
    expect(trace.queue).toContain(liveItem);
    expect(context.agentStream).toBe(state.agentStream);
    expect(context.agentTokenUsage).toBe(state.agentTokenUsage);
    expect(turn.hydrated).toBe(false);
  });

  it("restores the stream after a history rendering error and allows another attempt", () => {
    const { context, state, turn, transcript, liveTurn } = harness();
    transcript.renderInputSource.mockImplementationOnce(() => { throw new Error("Render failed"); });
    expect(() => { runInNewContext("hydrateOutputTurnOnOpen(event)", context); }).toThrow("Render failed");
    expect(turn.hydrated).toBe(false);
    for (const key of Object.keys(state) as Array<keyof typeof state>) expect(context[key], key).toBe(state[key]);
    expect(context.transcript.active).toBe(liveTurn);
    runInNewContext("hydrateOutputTurnOnOpen(event)", context);
    expect(turn.hydrated).toBe(true);
  });
});

it("hydrates unknown historical results as read-only output without dispatching an interaction", () => {
  const { context, liveTurn } = harness();
  const response = { kind: "workflow", executions: [{ method: { id: "ui.choose" }, result: { kind: "ui", type: "choice", selected: ["old"] } }] };
  context.record.output = JSON.stringify(response);
  const renderResult = vi.fn(); Object.assign(context, { renderResult });
  runInNewContext("hydrateOutputTurnOnOpen(event)", context);
  expect(renderResult).toHaveBeenCalledWith(response);
  expect(context.renderAgentEvent).toHaveBeenCalledTimes(1);
  expect(context.transcript.active).toBe(liveTurn);
});
