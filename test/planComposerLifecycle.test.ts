import { describe, expect, it, vi } from "vitest";
import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { DextHistoryStore, type DextHistorySession } from "../src/historyStore.js";
import type { ExecutionMetadata, InputExecutionResponse } from "../src/core/types.js";

vi.mock("vscode", () => ({}));

function harness(error?: string) {
  const session: DextHistorySession = { id: "session", createdAt: 1, updatedAt: 1, turns: [], planStatus: "running", activePlanPath: "old.plan.md" };
  let stored: unknown = [session];
  const state = { get: () => stored, update: async (_key: string, value: unknown) => { stored = value; } };
  const history = new DextHistoryStore(state as never);
  const execute = vi.fn(async (_mode: string, _source: string, metadata: ExecutionMetadata): Promise<InputExecutionResponse> => {
    if (error) throw new Error(error);
    return { kind: "workflow", executions: [{
      invocation: { kind: "invocation", method: "plan", arguments: [], source: "chat" },
      method: { id: "plan", title: "Plan", kind: "command", source: "builtin" }, durationMs: 1,
      result: { kind: "plan", executePlan: !!metadata.executePlan, planPath: metadata.planPath ?? "new.plan.md", text: metadata.executePlan
        ? 'Done <!-- dext-todo: {"updates":[{"id":"plan-1","status":"completed"}],"verification":"passed"} -->' : "Done" }
    }] };
  });
  const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
  Object.assign(sidebar, {
    activeSession: session, activeExecutions: new Map(), conversationSelections: new Map(), sessions: new Map(), pendingPatches: new Map(),
    application: { state: () => ({ agentSelection: {} }), agentProfiles: () => [], executeConversation: execute, planUri: () => ({}) },
    history, postAgentEvent: vi.fn(), post: vi.fn(), postConversationState: vi.fn(), postPlanContext: vi.fn(), updateRunningContext: vi.fn(),
    persistProviderSessions: vi.fn(), flushAttachmentDeletes: vi.fn(), uiInteraction: vi.fn(), hydrateSessions: vi.fn()
  });
  const run = (build = true, path?: string) => (sidebar as unknown as {
    run(mode: string, source: string, path: string | undefined, build: boolean): Promise<void>;
  }).run("plan", build ? "## Tasks\n1. [ ] Implement and verify" : "Request", path, build);
  return { session, sidebar, history, execute, run };
}

describe("Plan composer after execution", () => {
  it("resumes a persisted task checkpoint with verification instead of implementing completed work again", async () => {
    const { session, execute, run } = harness();
    session.planProgress = { path: "old.plan.md", todos: [{ id: "plan-1", text: "Implement and verify", status: "completed" }] };
    await run();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toContain("FINAL VERIFICATION");
    expect(session.turns[0]?.planOutcome?.status).toBe("completed");
  });
  it("stops before another round when the user cancels, preserving partial progress", async () => {
    const { sidebar, session, execute, history, run } = harness();
    execute.mockImplementation(async (_mode, _source, metadata) => {
      metadata.onAgentEvent?.({ phase: "message", text: '<!-- dext-todo: {"updates":[{"id":"plan-1","status":"in_progress"}]} -->' });
      const active = (sidebar as unknown as { activeExecutions: Map<string, { controller: AbortController }> }).activeExecutions.get("session")!;
      active.controller.abort(); throw new Error("Cancelled");
    });
    await run();
    expect(execute).toHaveBeenCalledOnce();
    expect(session).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "active" });
    expect(history.list()[0]?.planProgress?.todos[0]?.status).toBe("in_progress");
    expect(session.turns[0]?.planOutcome?.status).toBe("cancelled");
  });
  it("continues using the returned native session and ignores late progress from an earlier round", async () => {
    const { sidebar, execute, run, session } = harness();
    let oldMetadata: ExecutionMetadata | undefined;
    const original = execute.getMockImplementation()!;
    Object.assign(sidebar, { application: { state: () => ({ agentSelection: {} }), agentProfiles: () => [{ id: "codex", provider: "codex" }], executeConversation: execute } });
    execute.mockImplementation(async (mode, source, metadata) => {
      if (oldMetadata) {
        expect(metadata.conversationProviderSessionId).toBe("native-session");
        oldMetadata.onAgentEvent?.({ phase: "message", text: '<!-- dext-todo: {"updates":[{"id":"plan-1","status":"pending"}]} -->' });
      } else { oldMetadata = metadata; metadata.onAgentSessionId?.("codex", "native-session"); }
      return original(mode, source, metadata);
    });
    await run();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(session.turns[0]?.planOutcome?.status).toBe("completed");
  });
  it("starts the next request as a new plan while retaining the completed execution's file", async () => {
    const { session, history, execute, run } = harness();
    await run();
    expect(session.planStatus).toBe("new");
    expect(session.activePlanPath).toBeUndefined();
    const saved = history.list()[0]!;
    expect(saved.planStatus).toBe("new");
    expect(saved.activePlanPath).toBeUndefined();
    expect(saved.turns[0]).toMatchObject({ executePlan: true, planPath: "old.plan.md" });
    await run(false);
    expect(execute.mock.calls[2]?.[2].planPath).toBeUndefined();
    expect(session.activePlanPath).toBe("new.plan.md");
    expect(session.planStatus).toBe("active");
  });

  it.each(["Cancelled", "Build failed"])("keeps the selected plan when execution ends with %s", async (error) => {
    const { session, history, run } = harness(error);
    await run();
    expect(session).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "failed" });
    expect(history.list()[0]).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "failed" });
  });

  it("allows explicitly selecting the completed plan for revision", async () => {
    const { sidebar, session, execute, run } = harness();
    await run();
    await sidebar.setActivePlan("old.plan.md");
    await run(false, session.activePlanPath);
    expect(execute.mock.calls[2]?.[2]).toMatchObject({ planPath: "old.plan.md" });
    expect(session).toMatchObject({ activePlanPath: "old.plan.md", planStatus: "active" });
  });

  it("only resets the conversation whose plan finished in the background", async () => {
    const { sidebar, session, execute, run } = harness();
    const other = { id: "other", activePlanPath: "other.plan.md", planStatus: "active" };
    const original = execute.getMockImplementation()!;
    execute.mockImplementation(async (...args) => {
      Object.assign(sidebar, { activeSession: other });
      return original(...args);
    });
    await run();
    expect(session.planStatus).toBe("new");
    expect(other).toEqual({ id: "other", activePlanPath: "other.plan.md", planStatus: "active" });
  });
});
