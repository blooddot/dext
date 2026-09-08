import { describe, expect, it, vi } from "vitest";
import { DextSidebarProvider } from "../src/sidebarProvider.js";
import type { AgentStreamEvent, ExecutionMetadata, InputExecutionResponse } from "../src/core/types.js";
import type { DextHistoryRecord } from "../src/historyStore.js";

vi.mock("vscode", () => ({}));

describe("Plan execution task initialization", () => {
  it("publishes task rows before calling the agent and saves explicit progress without protocol comments", async () => {
    const source = "# Old plan\n## Tasks\n1. [ ] Inspect\n2. [ ] Verify";
    const posted: AgentStreamEvent[] = [];
    const initial = { id: "session", turns: [] as DextHistoryRecord[], planStatus: "running", activePlanPath: "old.plan.md" };
    const response: InputExecutionResponse = { kind: "workflow", executions: [{
      invocation: { kind: "invocation", method: "plan", arguments: [], source: "chat" },
      method: { id: "plan", title: "Plan", kind: "command", source: "builtin" }, durationMs: 1,
      result: { kind: "chat", executePlan: true, planPath: "old.plan.md", text: 'Checked. <!-- dext-todo: {"updates":[{"id":"plan-1","status":"completed"}]} -->' }
    }] };
    const execute = vi.fn(async (_mode: string, _source: string, metadata: ExecutionMetadata) => {
      expect(posted[0]?.todos?.map((item) => item.text)).toEqual(["Inspect", "Verify"]);
      expect(posted[0]?.todos?.every((item) => item.status === "pending")).toBe(true);
      metadata.onAgentEvent?.({ phase: "message", text: '<!-- dext-todo: {"updates":[{"id":"plan-1","status":"in_progress"}]} -->' });
      metadata.onAgentEvent?.({ phase: "message", id: "last", text: (response.executions[0]!.result as { text: string }).text });
      return response;
    });
    const saved = vi.fn(async (input: string, process: AgentStreamEvent[]) => ({ id: "turn", input, process, createdAt: 1, output: "Checked.", response }));
    const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
    Object.assign(sidebar, {
      activeSession: initial, activeExecutions: new Map(), conversationSelections: new Map(), sessions: new Map(), pendingPatches: new Map(),
      application: { state: () => ({ agentSelection: {} }), agentProfiles: () => [], executeConversation: execute },
      history: { addSuccess: saved, updatePlanContext: vi.fn() },
      postAgentEvent: (_sessionId: string, event: AgentStreamEvent) => posted.push(event),
      post: vi.fn(), postConversationState: vi.fn(), postPlanContext: vi.fn(), updateRunningContext: vi.fn(),
      persistProviderSessions: vi.fn(), flushAttachmentDeletes: vi.fn(), uiInteraction: vi.fn()
    });
    await (sidebar as unknown as { run(mode: string, source: string, path: undefined, executePlan: boolean): Promise<void> })
      .run("plan", source, undefined, true);
    expect(execute).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledOnce();
    expect(saved).toHaveBeenCalledWith(source, expect.any(Array), response, "session", "plan", expect.any(String), {
      executePlan: true, planPath: "old.plan.md"
    });
    const todos = initial.turns[0]!.process.filter((event) => event.phase === "todo").at(-1)?.todos;
    expect(todos?.map((item) => item.status)).toEqual(["completed", "pending"]);
    expect(posted.filter((event) => event.phase === "message").every((event) => !event.text.includes("dext-todo"))).toBe(true);
    expect((response.executions[0]!.result as { text: string }).text).toBe("Checked. ");
    expect(initial.planStatus).toBe("new");
    expect(initial.activePlanPath).toBeUndefined();
  });
});
