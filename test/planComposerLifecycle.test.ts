import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExecutionMetadata, InputExecutionResponse } from "../src/shared/contracts/types.js";
import type { DextHistorySession } from "../src/features/conversations/contracts/history.js";
import { createConversationHarness } from "./conversationHarness.js";
import { PlanController } from "../src/features/conversations/host/planController.js";

const planSource = "## Tasks\n1. [ ] Implement and verify";
/** The same plan with the user-owned half the panel shows separately. */
const acceptedPlanSource = [
  "## Tasks",
  "1. [ ] Implement and verify",
  "",
  "## Acceptance",
  "",
  "- [ ] Open the Todo panel and see the acceptance group",
  "- [ ] Press Build and watch the acceptance count stay at 0/2"
].join("\n");

async function harness(error?: string, planText = planSource) {
  const session: DextHistorySession = {
    id: "session", createdAt: 1, updatedAt: 1, turns: [],
    planStatus: "active", activePlanPath: "old.plan.md"
  };
  const harness = createConversationHarness({
    planText,
    profiles: [{ id: "codex", provider: "codex", command: "codex", label: "Codex", models: [] }],
    executeConversation: async (_mode: string, _source: string, metadata: ExecutionMetadata): Promise<InputExecutionResponse> => {
      if (error) throw new Error(error);
      return { kind: "workflow", executions: [{
        invocation: { kind: "invocation", method: "plan", arguments: [], source: "chat" },
        method: { id: "plan", title: "Plan", kind: "command", source: "builtin" }, durationMs: 1,
        result: { kind: "plan", executePlan: !!metadata.executePlan, planPath: metadata.planPath ?? "new.plan.md", text: metadata.executePlan
          ? 'Done <!-- dext-todo: {"updates":[{"id":"plan-1","status":"completed"}],"verification":"passed"} -->' : "Done" }
      }] };
    }
  });
  await harness.seed([session]);
  harness.controller.activate(harness.controller.session(session.id)!);
  const active = harness.controller.active();
  // Building re-reads the plan file and starts the execution turn, exactly as
  // the composer's Build button does.
  const run = (executePlan = true, planPath?: string) => executePlan
    ? harness.plans.build("old.plan.md")
    : harness.coordinator.execute(active, "plan", planSource, {
      ...(planPath !== undefined ? { planPath } : {}),
      executePlan: false
    });
  return { ...harness, session: active, run };
}

function queuedPlan(hash: string): InputExecutionResponse {
  return { kind: "workflow", executions: [{
    invocation: { kind: "invocation", method: "executePlan", arguments: [{ name: "planHash", value: hash }], source: "code" },
    method: { id: "executePlan", title: "Execute Plan", kind: "command", source: "builtin" }, durationMs: 1,
    result: { kind: "plan", planPath: "old.plan.md", text: "Queued" }
  }] };
}

describe("Plan composer after execution", () => {
  it("resumes task completion saved for the same plan", () => {
    const h = createConversationHarness();
    const session: DextHistorySession = { id: "s", createdAt: 1, updatedAt: 1, turns: [],
      planProgress: { path: "a.plan.md", todos: [{ id: "plan-1", text: "Implement and verify", status: "completed" }] }
    };
    expect(h.plans.startRun(session, planSource, true, "a.plan.md").todoProgress?.snapshot()[0]?.status).toBe("completed");
    expect(h.plans.startRun(session, planSource.replace("Implement and verify", "Implement a revised contract"), true, "a.plan.md")
      .todoProgress?.snapshot()[0]?.status).toBe("pending");
    session.planProgress = { path: "b.plan.md", todos: [{ id: "plan-1", text: "Implement and verify", status: "completed" }] };
    expect(h.plans.startRun(session, planSource, true, "a.plan.md").todoProgress?.snapshot()[0]?.status).toBe("pending");
  });
  it("builds the Plan after the successful Code turn in the originating conversation", async () => {
    const h = await harness();
    const other: DextHistorySession = { id: "other", createdAt: 2, updatedAt: 2, turns: [], planStatus: "active", activePlanPath: "other.plan.md" };
    h.executeInput.mockImplementation(async () => {
      h.controller.activate(other);
      return queuedPlan(createHash("sha256").update(planSource).digest("hex"));
    });
    await h.coordinator.execute(h.session, "code", "await executePlan(...)");
    expect(h.executeInput.mock.calls[0]?.[1].canQueuePlanExecution).toBe(true);
    expect(h.executeConversation.mock.calls[0]?.[2]).toMatchObject({ executePlan: true, planPath: "old.plan.md", agentSessionId: h.session.id });
    expect(h.session.turns.map((turn) => turn.mode)).toEqual(["code", "plan"]);
    expect(h.session.planStatus).toBe("new");
    expect(other.planStatus).toBe("active");
  });

  it("rejects a Plan that changed after its Code request was queued", async () => {
    const h = await harness();
    h.executeInput.mockResolvedValue(queuedPlan(createHash("sha256").update("other plan revision").digest("hex")));
    await expect(h.coordinator.execute(h.session, "code", "await executePlan(...)")).rejects.toThrow("changed after it was queued");
    expect(h.executeConversation).not.toHaveBeenCalled();
    expect(h.session.planStatus).toBe("active");
  });
  it("resumes a persisted task checkpoint with verification instead of implementing completed work again", async () => {
    const h = await harness();
    h.session.planProgress = { path: "old.plan.md", todos: [{ id: "plan-1", text: "Implement and verify", status: "completed" }] };
    await h.run();
    expect(h.executeConversation).toHaveBeenCalledOnce();
    expect(h.executeConversation.mock.calls[0]?.[1]).toContain("FINAL VERIFICATION");
    expect(h.controller.session("session")?.turns[0]?.planOutcome?.status).toBe("completed");
  });

  it("accepts a user toggle after the plan completed, and rejects a request the stored plan cannot claim", async () => {
    const h = await harness(undefined, acceptedPlanSource);
    await h.run();
    const session = h.controller.session("session")!;
    // Completion clears the active target, which is why the check must use the
    // saved progress path instead.
    expect(session.activePlanPath).toBeUndefined();
    expect(session.planStatus).toBe("new");
    const seeded = (await h.history.sessions())[0]!.planProgress!.acceptance!;
    expect(seeded.map((item) => [item.text, item.checked])).toEqual([
      ["Open the Todo panel and see the acceptance group", false],
      ["Press Build and watch the acceptance count stay at 0/2", false]
    ]);
    await h.plans.toggleAcceptance("old.plan.md", seeded[0]!.id, true);
    expect(h.controller.session("session")?.planProgress).toMatchObject({
      path: "old.plan.md", acceptance: [{ id: seeded[0]!.id, checked: true }, { id: seeded[1]!.id, checked: false }]
    });
    // The host answers a toggle with the state it just persisted.
    expect(h.messages.filter((message) => message.type === "planAcceptance").at(-1)).toMatchObject({
      sessionId: "session", planPath: "old.plan.md", items: [{ checked: true }, { checked: false }]
    });
    // A reload reads it back from history, not from the turn snapshot.
    expect((await h.history.sessions())[0]?.planProgress?.acceptance?.map((item) => item.checked)).toEqual([true, false]);

    const before = await h.history.sessions();
    await expect(h.plans.toggleAcceptance("other.plan.md", seeded[1]!.id, true)).rejects.toThrow("no saved acceptance list");
    await expect(h.plans.toggleAcceptance("old.plan.md", "accept-missing", true)).rejects.toThrow("not part of this plan");
    expect(await h.history.sessions()).toEqual(before);
  });

  it("stops before another round when the user cancels, preserving partial progress", async () => {
    const h = await harness();
    h.executeConversation.mockImplementation(async (_mode, _source, metadata) => {
      metadata.onAgentEvent?.({ phase: "message", text: '<!-- dext-todo: {"updates":[{"id":"plan-1","status":"in_progress"}]} -->' });
      h.coordinator.abort("session");
      throw new Error("Cancelled");
    });
    await h.run();
    expect(h.executeConversation).toHaveBeenCalledOnce();
    expect(h.session).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "active" });
    expect((await h.history.sessions())[0]?.planProgress?.todos[0]?.status).toBe("in_progress");
    expect(h.controller.session("session")?.turns[0]?.planOutcome?.status).toBe("cancelled");
  });

  it("continues using the returned native session and ignores late progress from an earlier round", async () => {
    const h = await harness();
    let oldMetadata: ExecutionMetadata | undefined;
    const original = h.executeConversation.getMockImplementation()!;
    h.executeConversation.mockImplementation(async (mode, source, metadata) => {
      if (oldMetadata) {
        expect(metadata.conversationProviderSessionId).toBe("native-session");
        oldMetadata.onAgentEvent?.({ phase: "message", text: '<!-- dext-todo: {"updates":[{"id":"plan-1","status":"pending"}]} -->' });
      } else {
        oldMetadata = metadata;
        metadata.onAgentSessionId?.("codex", "native-session");
      }
      return original(mode, source, metadata);
    });
    await h.run();
    expect(h.executeConversation).toHaveBeenCalledTimes(2);
    expect(h.controller.session("session")?.turns[0]?.planOutcome?.status).toBe("completed");
    expect(h.controller.session("session")?.planProgress?.todos[0]?.status).toBe("completed");
  });

  it("starts the next request as a new plan while retaining the completed execution's file", async () => {
    const h = await harness();
    await h.run();
    expect(h.session.planStatus).toBe("new");
    expect(h.session.activePlanPath).toBeUndefined();
    const saved = (await h.history.sessions())[0]!;
    expect(saved.planStatus).toBe("new");
    expect(saved.activePlanPath).toBeUndefined();
    expect(saved.turns[0]).toMatchObject({ executePlan: true, planPath: "old.plan.md" });
    await h.run(false);
    expect(h.executeConversation.mock.calls.at(-1)?.[2].planPath).toBeUndefined();
    expect(h.session.activePlanPath).toBe("new.plan.md");
    expect(h.session.planStatus).toBe("active");
  });

  it.each(["Cancelled", "Build failed"])("keeps the selected plan when execution ends with %s", async (error) => {
    const h = await harness(error);
    await h.run();
    expect(h.session).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "failed" });
    expect((await h.history.sessions())[0]).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "failed" });
  });

  it("allows explicitly selecting the completed plan for revision", async () => {
    const h = await harness();
    await h.run();
    await h.plans.setActivePlan("old.plan.md");
    await h.run(false, h.session.activePlanPath);
    expect(h.executeConversation.mock.calls.at(-1)?.[2]).toMatchObject({ planPath: "old.plan.md" });
    expect(h.session).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "active" });
  });

  it("only resets the conversation whose plan finished in the background", async () => {
    const h = await harness();
    const other: DextHistorySession = { id: "other", createdAt: 2, updatedAt: 2, turns: [], activePlanPath: "other.plan.md", planStatus: "active" };
    const original = h.executeConversation.getMockImplementation()!;
    h.executeConversation.mockImplementation(async (...args) => {
      h.controller.activate(other);
      return original(...args);
    });
    await h.run();
    expect(h.controller.session("session")?.planStatus).toBe("new");
    expect(other).toMatchObject({ activePlanPath: "other.plan.md", planStatus: "active" });
  });

  it("restores the plan status when the turn never starts", async () => {
    const statuses: string[] = [];
    const session: DextHistorySession = { id: "s", createdAt: 1, updatedAt: 1, turns: [], activePlanPath: "a.plan.md", planStatus: "active" };
    const plans = new PlanController({
      host: { isTrustedLocalWorkspace: () => true, readPlan: async () => planSource, knownPlan: () => true },
      sessions: {
        active: () => session,
        savePlanContext: async (_id, _path, status) => { statuses.push(status); },
        savePlanProgress: async () => undefined,
        postPlanContext: async () => undefined,
        postPlanAcceptance: async () => undefined
      },
      running: () => false,
      startTurn: async () => { throw new Error("Wait for this conversation's current Dext turn to finish."); }
    });
    await expect(plans.build("a.plan.md")).rejects.toThrow("Wait for this conversation");
    expect(session).toMatchObject({ activePlanPath: "a.plan.md", planStatus: "active" });
    expect(statuses.at(-1)).toBe("active");
  });
});
