import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { InputExecutionResponse } from "../src/core/types.js";
import type { DextHistoryRecord } from "../src/historyStore.js";
import { planExecutionLabel } from "../src/agentTodoPresentation.js";

// Exercise the actual deferred renderer without bootstrapping the editor or VS Code.
const main = readFileSync("src/webview/main.ts", "utf8");
const hydration = ts.transpileModule(main.slice(
  main.indexOf("function storedResponse("), main.indexOf("function hydrateOutputTurnOnOpen(")
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function hydrate(record: DextHistoryRecord) {
  const remove = vi.fn();
  const input = { childElementCount: 0, closest: () => ({ remove }), append: vi.fn() };
  const turn = {
    planExecutionStatus: { hidden: true, textContent: "" },
    input, title: { setPlanPath: vi.fn() }, todos: { setRunning: vi.fn() },
    processDisclosure: { open: true }, outputDisclosure: { open: false }, output: { append: vi.fn() }
  };
  const renderedInputSource = vi.fn();
  const renderResult = vi.fn();
  const renderOutputError = vi.fn();
  runInNewContext(`${hydration}\nhydrateStoredTurn(record, turn);`, {
    record, turn, planExecutionLabel, activeTurn: undefined, agentStream: undefined, agentRunStartedAt: undefined,
    resetAgentTrace: vi.fn(), renderAgentEvent: vi.fn(), syncResultToggle: vi.fn(),
    withIsolatedAgentTrace: (_turn: unknown, render: () => void) => render(),
    document: { createElement: () => ({ append: vi.fn() }) }, copyButton: vi.fn(),
    renderedInputSource, renderResult, renderOutputError, jsonOutput: vi.fn()
  });
  return { turn, remove, renderedInputSource, renderResult, renderOutputError };
}

function response(executePlan: boolean): InputExecutionResponse {
  return { kind: "workflow", executions: [{
    invocation: { kind: "invocation", method: "plan", arguments: [], source: "chat" },
    method: { id: "plan", title: "Plan", kind: "command", source: "builtin" }, durationMs: 1,
    result: { kind: "chat", executePlan, planPath: "plans/build.plan.md", text: "Finished" }
  }] };
}

const base: DextHistoryRecord = { id: "turn", createdAt: 1, input: "internal prompt", process: [], output: "", mode: "plan" };

describe("stored Plan turn hydration", () => {
  it.each(["blocked", "incomplete", "completed", "cancelled"] as const)("restores the persisted %s execution outcome", (status) => {
    const view = hydrate({ ...base, executePlan: true, planOutcome: { status, reason: "fixture", rounds: 3 }, response: response(true) });
    expect(view.turn.planExecutionStatus.textContent).toBe({ blocked: "Blocked", incomplete: "Incomplete", completed: "Completed", cancelled: "Stopped" }[status]);
  });
  it.each(["response", "serialized"])("removes legacy Input before rendering its prompt (%s)", (format) => {
    const result = response(true);
    const view = hydrate({ ...base, ...(format === "response" ? { response: result } : { output: JSON.stringify(result) }) });
    expect(view.remove).toHaveBeenCalledOnce();
    expect(view.turn.input).toBeUndefined();
    expect(view.renderedInputSource).not.toHaveBeenCalled();
    expect(view.turn.title.setPlanPath).toHaveBeenCalledWith("plans/build.plan.md");
    expect(view.renderResult).toHaveBeenCalledWith(result);
    expect(view.turn.processDisclosure.open).toBe(false);
    expect(view.turn.outputDisclosure.open).toBe(true);
    expect(view.turn.planExecutionStatus).toEqual({ hidden: false, textContent: "Incomplete" });
  });

  it.each(["Cancelled", "Agent failed"])("keeps Input hidden when the Plan has no response (%s)", (error) => {
    const view = hydrate({ ...base, executePlan: true, planPath: "plans/build.plan.md", error });
    expect(view.remove).toHaveBeenCalledOnce();
    expect(view.renderedInputSource).not.toHaveBeenCalled();
    expect(view.renderOutputError).toHaveBeenCalledWith(error);
    expect(view.turn.planExecutionStatus).toEqual({ hidden: false, textContent: "Failed" });
  });

  it("preserves the user's Input when drafting a Plan", () => {
    const view = hydrate({ ...base, input: "Write a plan", response: response(false) });
    expect(view.remove).not.toHaveBeenCalled();
    expect(view.renderedInputSource).toHaveBeenCalledWith("Write a plan");
  });
});
