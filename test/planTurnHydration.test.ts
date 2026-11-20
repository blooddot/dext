import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { InputExecutionResponse, PlanAcceptanceItem } from "../src/shared/contracts/types.js";
import type { DextHistoryRecord } from "../src/features/conversations/contracts/history.js";
import { planExecutionLabel } from "../src/features/conversations/presentation/agentTodoPresentation.js";
import { readHistoryResponse } from "../src/features/conversations/domain/historyResponse.js";
import { presentTurn } from "../src/features/conversations/presentation/turnPresentation.js";

// Exercise the actual deferred renderer without bootstrapping the editor or VS Code.
const main = readFileSync("src/webview/main.ts", "utf8");
const hydration = ts.transpileModule(main.slice(
  main.indexOf("function storedResponse("), main.indexOf("function hydrateOutputTurnOnOpen(")
), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function hydrate(
  record: DextHistoryRecord,
  options: { sessionId?: string; planPath?: string; acceptance?: PlanAcceptanceItem[] } = {}
) {
  const turn = {
    planExecutionStatus: { hidden: true, textContent: "" },
    title: { setPlanPath: vi.fn() }, todos: { setRunning: vi.fn(), setAcceptance: vi.fn() },
    processDisclosure: { open: true }, processMeta: { textContent: "" }, output: { append: vi.fn() }
  };
  const renderResult = vi.fn();
  const renderOutputError = vi.fn();
  // The row the Webview created is the only turn of this conversation, so it owns
  // the acceptance group exactly as it would in the panel.
  const transcript = { active: undefined, values: () => new Map([["turn", turn]]).values() };
  const acceptance = options.acceptance ?? [];
  const sessionId = options.sessionId;
  const planPath = options.planPath;
  runInNewContext(`${hydration}\nhydrateStoredTurn(record, turn, sessionId);`, {
    record, turn, transcript, sessionId, planExecutionLabel, readHistoryResponse, presentTurn,
    // The Webview mirrors what the host stored; these are the pieces of that
    // state renderStoredTurn reads.
    planAcceptanceBySession: new Map(sessionId && planPath && acceptance.length ? [[sessionId, { path: planPath, items: acceptance }]] : []),
    planLabelStates: new WeakMap(),
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
    expect(view.renderOutputError).toHaveBeenCalledWith(error, undefined);
    expect(view.turn.planExecutionStatus).toEqual({ hidden: false, textContent: "Failed" });
  });

  it("leaves the title to the input when the turn did not execute a Plan", () => {
    const view = hydrate({ ...base, input: "Write a plan", response: response(false) });
    expect(view.turn.title.setPlanPath).not.toHaveBeenCalled();
    expect(view.renderResult).toHaveBeenCalledWith(response(false));
  });

  it("reads the stored acceptance into a finished Plan turn instead of Blocked", () => {
    const acceptance = [
      { id: "accept-aaaa", text: "Open the panel", checked: false },
      { id: "accept-bbbb", text: "Press Build", checked: true }
    ];
    const view = hydrate({
      ...base, executePlan: true, planPath: "plans/build.plan.md",
      planOutcome: { status: "completed", reason: "fixture", rounds: 2 }, response: response(true)
    }, { sessionId: "session", planPath: "plans/build.plan.md", acceptance });
    expect(view.turn.planExecutionStatus.textContent).toBe("Completed · awaiting acceptance");
    expect(view.turn.planExecutionStatus.textContent).not.toContain("Blocked");
    expect(view.turn.todos.setAcceptance).toHaveBeenCalledWith(acceptance);
  });

  it("shows acceptance complete once the user checks the last item", () => {
    const view = hydrate({
      ...base, executePlan: true, planPath: "plans/build.plan.md",
      planOutcome: { status: "completed", reason: "fixture", rounds: 2 }, response: response(true)
    }, {
      sessionId: "session", planPath: "plans/build.plan.md",
      acceptance: [{ id: "accept-aaaa", text: "Open the panel", checked: true }]
    });
    expect(view.turn.planExecutionStatus.textContent).toBe("Completed · acceptance complete");
  });

  it("keeps the original Completed label for a plan without an acceptance section", () => {
    const view = hydrate({
      ...base, executePlan: true, planPath: "plans/build.plan.md",
      planOutcome: { status: "completed", reason: "fixture", rounds: 2 }, response: response(true)
    }, { sessionId: "session", planPath: "plans/build.plan.md" });
    expect(view.turn.planExecutionStatus.textContent).toBe("Completed");
    expect(view.turn.todos.setAcceptance).toHaveBeenCalledWith([]);
  });
});
