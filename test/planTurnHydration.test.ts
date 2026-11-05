import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { InputExecutionResponse } from "../src/shared/contracts/types.js";
import type { DextHistoryRecord } from "../src/features/conversations/contracts/history.js";
import { planExecutionLabel } from "../src/features/conversations/presentation/agentTodoPresentation.js";
import { readHistoryResponse } from "../src/features/conversations/domain/historyResponse.js";
import { presentTurn } from "../src/features/conversations/presentation/turnPresentation.js";

// Exercise the actual deferred renderer without bootstrapping the editor or VS Code.
const main = readFileSync("src/webview/main.ts", "utf8");
const hydration = ts.transpileModule(main.slice(
  main.indexOf("function storedResponse("), main.indexOf("function hydrateOutputTurnOnOpen(")
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function hydrate(record: DextHistoryRecord) {
  const turn = {
    planExecutionStatus: { hidden: true, textContent: "" },
    title: { setPlanPath: vi.fn() }, todos: { setRunning: vi.fn() },
    processDisclosure: { open: true }, processMeta: { textContent: "" }, output: { append: vi.fn() }
  };
  const renderResult = vi.fn();
  const renderOutputError = vi.fn();
  const transcript = { active: undefined };
  runInNewContext(`${hydration}\nhydrateStoredTurn(record, turn);`, {
    record, turn, transcript, planExecutionLabel, readHistoryResponse, presentTurn,
    agentStream: undefined, agentRunStartedAt: undefined,
    resetAgentTrace: vi.fn(), renderAgentEvent: vi.fn(),
    withIsolatedAgentTrace: (_turn: unknown, render: () => void) => render(),
    document: { createElement: () => ({ append: vi.fn(), setAttribute: vi.fn() }) }, copyButton: vi.fn(),
    renderResult, renderOutputError, jsonOutput: vi.fn()
  });
  return { turn, renderResult, renderOutputError };
}

function response(executePlan: boolean): InputExecutionResponse {
  return { kind: "workflow", executions: [{
    invocation: { kind: "invocation", method: "plan", arguments: [], source: "chat" },
    method: { id: "plan", title: "Plan", kind: "command", source: "builtin" }, durationMs: 1,
    result: { kind: "plan", executePlan, planPath: "plans/build.plan.md", text: "Finished" }
  }] };
}

const base: DextHistoryRecord = { id: "turn", createdAt: 1, input: "internal prompt", process: [], output: "", mode: "plan" };

describe("stored Plan turn hydration", () => {
  it.each(["response", "serialized"])("hydrates legacy chat results with Plan links and outcomes (%s)", (format) => {
    const legacy = JSON.parse(JSON.stringify(response(true)).replace('"kind":"plan"', '"kind":"chat"')) as InputExecutionResponse;
    const view = hydrate({ ...base, ...(format === "response" ? { response: legacy } : { output: JSON.stringify(legacy) }) });
    expect(view.renderResult).toHaveBeenCalledWith(response(true));
    expect(view.turn.title.setPlanPath).toHaveBeenCalledWith("plans/build.plan.md");
  });

  it.each(["blocked", "incomplete", "completed", "cancelled"] as const)("restores the persisted %s execution outcome", (status) => {
    const view = hydrate({ ...base, executePlan: true, planOutcome: { status, reason: "fixture", rounds: 3 }, response: response(true) });
    expect(view.turn.planExecutionStatus.textContent).toBe({ blocked: "Blocked", incomplete: "Incomplete", completed: "Completed", cancelled: "Stopped" }[status]);
  });

  it.each(["response", "serialized"])("swaps the row label for the Plan title and reveals the answer (%s)", (format) => {
    const result = response(true);
    const view = hydrate({ ...base, ...(format === "response" ? { response: result } : { output: JSON.stringify(result) }) });
    expect(view.turn.title.setPlanPath).toHaveBeenCalledWith("plans/build.plan.md");
    expect(view.renderResult).toHaveBeenCalledWith(result);
    expect(view.turn.processDisclosure.open).toBe(false);
    expect(view.turn.planExecutionStatus).toEqual({ hidden: false, textContent: "Incomplete" });
    expect(view.turn.processMeta.textContent).toBe("Worked 1ms");
  });

  it.each(["Cancelled", "Agent failed"])("keeps the Plan label when the Plan has no response (%s)", (error) => {
    const view = hydrate({ ...base, executePlan: true, planPath: "plans/build.plan.md", error });
    expect(view.renderOutputError).toHaveBeenCalledWith(error);
    expect(view.turn.planExecutionStatus).toEqual({ hidden: false, textContent: "Failed" });
  });

  it("leaves the title to the input when the turn did not execute a Plan", () => {
    const view = hydrate({ ...base, input: "Write a plan", response: response(false) });
    expect(view.turn.title.setPlanPath).not.toHaveBeenCalled();
    expect(view.renderResult).toHaveBeenCalledWith(response(false));
  });
});
