import { describe, expect, it } from "vitest";
import type { AgentStreamEvent, InputExecutionResponse } from "../src/shared/contracts/types.js";
import type { DextHistorySession } from "../src/features/conversations/contracts/history.js";
import { createConversationHarness } from "./conversationHarness.js";
import type { PlanProjectContext } from "../src/shared/contracts/planProject.js";

describe("Plan execution task initialization", () => {
  it.each(["none", "change", "unknown", "conflict"] as const)("gates completion on actual Project impact %s", async assessment => {
    const context: PlanProjectContext = { workspaceKey: "w", planPath: "a.plan.md", documentHash: "h", fileHash: "f", availability: "ready", assessment: "none", reason: "anticipated none", basis: [], reviewStatus: "current" };
    let captured = false;
    const h = createConversationHarness({
      startPlanProject: async context => { captured = true; return { ...context, evidenceId: "saved-baseline" }; },
      finishPlanProject: async context => ({ ...context, assessment, reason: "actual impact", reviewStatus: assessment === "none" ? "reconciled" : "pending" }),
      executeConversation: async () => {
        expect(captured).toBe(true);
        return { kind: "workflow", executions: [{ invocation: { kind: "invocation", method: "plan", arguments: [], source: "chat" }, method: { id: "plan", title: "Plan", kind: "command", source: "builtin" }, durationMs: 1,
          result: { kind: "plan", text: '<!-- dext-todo: {"updates":[{"id":"plan-1","status":"completed"}],"verification":"passed"} -->' } }] };
      }
    });
    h.seed([{ id: "s", createdAt: 1, updatedAt: 1, turns: [], activePlanPath: "a.plan.md", planStatus: "running", projectContext: context }]);
    const session = h.controller.session("s")!;
    await h.coordinator.execute(session, "plan", "## Tasks\n1. [ ] Work", { executePlan: true });
    expect(session.turns[0]?.planOutcome?.status).toBe(assessment === "none" ? "completed" : "incomplete");
    expect(session.activePlanPath).toBe(assessment === "none" ? undefined : "a.plan.md");
    expect(session.turns[0]?.projectContext?.evidenceId).toBe("saved-baseline");
  });
  it("publishes task rows before calling the agent and saves explicit progress without protocol comments", async () => {
    const source = "# Old plan\n## Tasks\n1. [ ] Inspect\n2. [ ] Verify";
    const initial: DextHistorySession = {
      id: "session", createdAt: 1, updatedAt: 1, turns: [], planStatus: "running", activePlanPath: "old.plan.md"
    };
    const response: InputExecutionResponse = { kind: "workflow", executions: [{
      invocation: { kind: "invocation", method: "plan", arguments: [], source: "chat" },
      method: { id: "plan", title: "Plan", kind: "command", source: "builtin" }, durationMs: 1,
      result: {
        kind: "plan",
        executePlan: true,
        planPath: "old.plan.md",
        text: 'Checked. <!-- dext-todo: {"updates":[{"id":"plan-1","status":"completed"}]} -->'
      }
    }] };
    const harness = createConversationHarness();
    // The session is not stored yet: hydrate a conversation opened from history,
    // then let the plan execution itself write the first turn.
    await harness.controller.open(initial);
    const session = harness.controller.session("session");
    if (!session) throw new Error("The plan conversation was not opened.");
    session.planStatus = "running";

    const execute = harness.executeConversation;
    execute.mockImplementation(async (_mode, _source, metadata) => {
      const roundResponse = structuredClone(response);
      // The task rows must already be in the turn's published event log when
      // the agent is called, not reconstructed after the answer arrives.
      const published = harness.coordinator.active("session")?.events ?? [];
      expect(published[0]?.todos?.map((item) => item.text)).toEqual(["Inspect", "Verify"]);
      // The event log keeps the current task snapshot across rounds. Initial
      // tasks must be pending; later rounds retain the reported completion.
      expect(published[0]?.todos?.map((item) => item.status)).toEqual(
        execute.mock.calls.length === 1 ? ["pending", "pending"] : ["completed", "pending"]
      );
      metadata.onAgentEvent?.({ phase: "message", text: '<!-- dext-todo: {"updates":[{"id":"plan-1","status":"in_progress"}]} -->' });
      metadata.onAgentEvent?.({
        phase: "message",
        id: "last",
        text: (roundResponse.executions[0]!.result as { text: string }).text
      });
      return roundResponse;
    });

    await harness.coordinator.execute(session, "plan", source, { planPath: "old.plan.md", executePlan: true });

    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[1]?.[1]).toContain("Continue the remaining actionable tasks");

    expect(session.turns).toHaveLength(1);
    const turn = session.turns[0]!;
    expect(turn.input).toBe(source);
    expect(turn.mode).toBe("plan");
    expect(turn.planPath).toBe("old.plan.md");
    expect(turn.executePlan).toBe(true);
    expect(turn.planOutcome).toMatchObject({ status: "incomplete", rounds: 4 });
    expect(harness.history.list()[0]?.turns[0]?.planOutcome).toMatchObject({ status: "incomplete", rounds: 4 });

    const todos = turn.process.filter((event) => event.phase === "todo").at(-1)?.todos;
    expect(todos?.map((item) => item.status)).toEqual(["completed", "pending"]);
    expect(session.planProgress?.path).toBe("old.plan.md");
    expect(session.planProgress?.todos.map((item) => item.status)).toEqual(["completed", "pending"]);
    expect(harness.history.list()[0]?.planProgress?.todos.map((item) => item.status)).toEqual(["completed", "pending"]);

    const agentEvents = harness.messages.flatMap((message): AgentStreamEvent[] =>
      message.type === "agentEvent" ? [message.event] : []);
    expect(agentEvents.filter((event) => event.phase === "todo")[0]?.todos?.map((item) => item.text))
      .toEqual(["Inspect", "Verify"]);
    expect(agentEvents.filter((event) => event.phase === "message").every((event) => !event.text.includes("dext-todo")))
      .toBe(true);
    expect((turn.response!.executions[0]!.result as { text: string }).text).toContain("Dext plan execution: incomplete");
    expect(session.planStatus).toBe("active");
    expect(session.activePlanPath).toBe("old.plan.md");
  });
});
