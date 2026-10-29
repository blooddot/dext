import { describe, expect, it } from "vitest";
import type { ExecutionMetadata, InputExecutionResponse } from "../src/shared/contracts/types.js";
import type { DextHistorySession } from "../src/features/conversations/contracts/history.js";
import { createConversationHarness } from "./conversationHarness.js";

const planSource = "## Tasks\n1. [ ] Implement and verify";

async function harness(error?: string) {
  const session: DextHistorySession = {
    id: "session", createdAt: 1, updatedAt: 1, turns: [],
    planStatus: "active", activePlanPath: "old.plan.md"
  };
  const harness = createConversationHarness({
    planText: planSource,
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
  harness.seed([session]);
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

describe("Plan composer after execution", () => {
  it("does not start a writable turn when Project preflight rejects changed norms", async () => {
    const h = createConversationHarness({ planText: planSource, preparePlanBuild: async () => { throw new Error("Project basis changed"); } });
    h.seed([{ id: "s", createdAt: 1, updatedAt: 1, turns: [], activePlanPath: "a.plan.md", planStatus: "active" }]);
    h.controller.activate(h.controller.session("s")!);
    await expect(h.plans.build("a.plan.md")).rejects.toThrow("Project basis changed");
    expect(h.executeConversation).not.toHaveBeenCalled();
    expect(h.controller.active().planStatus).toBe("active");
  });
  it("invalidates old task completion when document identity changes", () => {
    const h = createConversationHarness();
    const session: DextHistorySession = { id: "s", createdAt: 1, updatedAt: 1, turns: [],
      planProgress: { path: "a.plan.md", documentHash: "old", todos: [{ id: "plan-1", text: "Implement and verify", status: "completed" }] },
      projectContext: { workspaceKey: "w", planPath: "a.plan.md", documentHash: "new", fileHash: "f", availability: "absent", assessment: "unknown", reason: "", basis: [], reviewStatus: "pending" }
    };
    expect(h.plans.startRun(session, planSource, true, "a.plan.md").todoProgress?.snapshot()[0]?.status).toBe("pending");
    session.planProgress!.documentHash = "new";
    expect(h.plans.startRun(session, planSource, true, "a.plan.md").todoProgress?.snapshot()[0]?.status).toBe("completed");
  });
  it("resumes a persisted task checkpoint with verification instead of implementing completed work again", async () => {
    const h = await harness();
    h.session.planProgress = { path: "old.plan.md", todos: [{ id: "plan-1", text: "Implement and verify", status: "completed" }] };
    await h.run();
    expect(h.executeConversation).toHaveBeenCalledOnce();
    expect(h.executeConversation.mock.calls[0]?.[1]).toContain("FINAL VERIFICATION");
    expect(h.controller.session("session")?.turns[0]?.planOutcome?.status).toBe("completed");
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
    expect(h.history.list()[0]?.planProgress?.todos[0]?.status).toBe("in_progress");
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
    const saved = h.history.list()[0]!;
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
    expect(h.history.list()[0]).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "failed" });
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
});
