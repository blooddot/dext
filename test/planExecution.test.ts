import { describe, expect, it } from "vitest";
import { PlanExecution, resumePlanTodos } from "../src/core/planExecution.js";
import { planTodoItems } from "../src/core/planTodoProgress.js";
import { planExecutionLabel } from "../src/agentTodoPresentation.js";

const tasks = () => planTodoItems("## Tasks\n1. [ ] Implement\n2. [ ] Verify");
function report(run: PlanExecution, value: unknown): void {
  run.progress.consume({ phase: "message", text: `<!-- dext-todo: ${JSON.stringify(value)} -->` });
}
describe("plan continuation decisions", () => {
  it("requires a separate verification round after every task is complete", () => {
    const run = new PlanExecution(tasks()); run.beginRound();
    report(run, { updates: tasks().map((task) => ({ id: task.id, status: "completed" })), verification: "passed" });
    expect(run.finishRound()).toBeUndefined(); expect(run.verifying).toBe(true);
    expect(run.prompt("plan")).toContain("FINAL VERIFICATION");
    run.beginRound(); report(run, { verification: "passed" });
    expect(run.finishRound()).toMatchObject({ status: "completed", rounds: 2 });
  });
  it("continues independent tasks even when another task is blocked", () => {
    const run = new PlanExecution(tasks()); run.beginRound();
    report(run, { blocked: [{ id: "plan-1", reason: "Requires the user's browser authentication" }] });
    expect(run.finishRound()).toBeUndefined();
    run.beginRound(); report(run, { updates: [{ id: "plan-2", status: "completed" }] });
    expect(run.finishRound()).toMatchObject({ status: "blocked", reason: expect.stringContaining("browser authentication") });
  });
  it("pauses after three rounds of repeated activity, without falsely completing", () => {
    const run = new PlanExecution(tasks());
    for (let i = 0; i < 4; i++) {
      run.beginRound(); run.observe({ phase: "tool", title: "Check", text: "same result" });
      const outcome = run.finishRound();
      if (i < 3) expect(outcome).toBeUndefined(); else expect(outcome?.status).toBe("incomplete");
    }
  });
  it("lets new tool work continue a large task and enforces an explicit round ceiling", () => {
    const run = new PlanExecution(tasks(), 5);
    for (let i = 0; i < 5; i++) {
      run.beginRound(); run.observe({ phase: "tool", text: `new work ${i}` });
      const outcome = run.finishRound();
      if (i < 4) expect(outcome).toBeUndefined(); else expect(outcome?.reason).toContain("5-round");
    }
  });
  it("does not accept prose or a verification pass when tasks were reopened", () => {
    const run = new PlanExecution(tasks()); run.beginRound();
    report(run, { updates: tasks().map((task) => ({ id: task.id, status: "completed" })) }); run.finishRound();
    run.beginRound(); report(run, { verification: "passed", updates: [{ id: "plan-2", status: "in_progress" }] });
    expect(run.finishRound()).toBeUndefined(); expect(run.verifying).toBe(false);
  });
  it("rejects a malformed verification report atomically", () => {
    const run = new PlanExecution(tasks().map((task) => ({ ...task, status: "completed" })));
    run.beginRound(); report(run, { updates: [{ id: "unknown", status: "completed" }], verification: "passed" });
    expect(run.progress.verified).toBe(false); expect(run.finishRound()).toBeUndefined();
  });
  it("preserves matching progress but does not reuse changed task definitions", () => {
    const prior = tasks().map((task) => ({ ...task, status: "completed" as const }));
    expect(resumePlanTodos(tasks(), prior).every((task) => task.status === "completed")).toBe(true);
    expect(resumePlanTodos([{ ...tasks()[0]!, text: "Changed scope" }], prior)[0]?.status).toBe("pending");
  });
  it("does not claim completion for plans without trackable tasks or old history without evidence", () => {
    const run = new PlanExecution([]); run.beginRound(); expect(run.finishRound()?.status).toBe("incomplete");
    expect(planExecutionLabel([])).toBe("Incomplete");
    expect(planExecutionLabel([], undefined, { status: "blocked", reason: "auth", rounds: 2 })).toBe("Blocked");
    expect(planExecutionLabel([], "Stopped", { status: "cancelled", reason: "user", rounds: 1 })).toBe("Stopped");
  });
});
