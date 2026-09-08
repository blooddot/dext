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
      result: { kind: "chat", executePlan: !!metadata.executePlan, planPath: metadata.planPath ?? "new.plan.md", text: "Done" }
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
  }).run("plan", "Request", path, build);
  return { session, sidebar, history, execute, run };
}

describe("Plan composer after execution", () => {
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
    expect(execute.mock.calls[1]?.[2].planPath).toBeUndefined();
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
    expect(execute.mock.calls[1]?.[2]).toMatchObject({ planPath: "old.plan.md" });
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
