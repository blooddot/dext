import { describe, expect, it, vi } from "vitest";
import { DextHistoryStore } from "../src/historyStore.js";
import type { DextHistorySession } from "../src/historyStore.js";
import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { CliAgentRunner } from "../src/core/agentRunner.js";
import type { ExecutionMetadata } from "../src/core/types.js";

vi.mock("vscode", () => ({ commands: { executeCommand: vi.fn().mockResolvedValue(undefined) } }));

class MemoryState {
  private value: unknown;
  get<T>(_: string, fallback: T): T { return (this.value as T | undefined) ?? fallback; }
  async update(_: string, value: unknown): Promise<void> { this.value = value; }
}

function sidebarFixture(history: DextHistoryStore, sessions: DextHistorySession[]) {
  const sidebar = Object.create(DextSidebarProvider.prototype) as DextSidebarProvider;
  const post = vi.fn().mockResolvedValue(undefined);
  const endAgentSession = vi.fn();
  const activeExecutions = new Map<string, unknown>();
  Object.assign(sidebar, {
    history, sessionsHydrated: true,
    sessions: new Map(sessions.map((session) => [session.id, session])),
    activeSession: sessions.at(-1), activeExecutions,
    pendingPatches: new Map(), postedSessionSignatures: new Map(),
    postConversationState: vi.fn().mockResolvedValue(undefined), post,
    application: { endAgentSession, state: () => ({ agentSelection: { mode: "agent" } }) }
  });
  return { sidebar, post, endAgentSession, activeExecutions };
}

describe("shared History and Conversation actions", () => {
  it("keeps an existing conversation's Harness preset when a late selection arrives", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    await history.addSuccess("hello", [], { kind: "workflow", executions: [] }, "active", "agent", "turn");
    const { sidebar, post } = sidebarFixture(history, history.list());
    const selection = { mode: "agent", permission: "workspace-write", profileId: "deepseek-harness", model: "", reasoningEffort: "", speed: "", serviceTier: "", agentPreset: "standard" };
    const setConversationSelection = vi.fn().mockResolvedValue(undefined);
    const conversationSelections = new Map([["active", selection]]);
    Object.assign(sidebar, { conversationSelections, preferences: { setConversationSelection } });
    await (sidebar as unknown as { receive(message: unknown): Promise<void> }).receive({
      type: "agentSelection", selection: { ...selection, agentPreset: "ptc" }
    });
    expect(setConversationSelection).not.toHaveBeenCalled();
    expect(conversationSelections.get("active")?.agentPreset).toBe("standard");
    expect(JSON.stringify(post.mock.calls)).toContain("new conversation");
  });

  it("rejects late configuration changes while this conversation runs and unlocks independently of background runs", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    const session: DextHistorySession = { id: "active", createdAt: 1, updatedAt: 1, turns: [] };
    const { sidebar, activeExecutions, post } = sidebarFixture(history, [session]);
    const selection = { mode: "plan", permission: "full-access", profileId: "codex", model: "new-model", reasoningEffort: "high", speed: "", serviceTier: "" };
    const setConversationSelection = vi.fn().mockResolvedValue(undefined);
    const setAgentSelection = vi.fn();
    const conversationSelections = new Map();
    const refresh = vi.fn().mockResolvedValue(undefined);
    Object.assign(sidebar, {
      preferences: { setConversationSelection }, application: { setAgentSelection },
      conversationSelections, refresh, updateRunningContext: vi.fn()
    });
    const receive = (message: unknown) => (sidebar as unknown as { receive(message: unknown): Promise<void> }).receive(message);
    activeExecutions.set("active", { turnId: "running" });
    await receive({ type: "agentSelection", selection });
    expect(setConversationSelection).not.toHaveBeenCalled();
    expect(setAgentSelection).not.toHaveBeenCalled();
    expect(conversationSelections.size).toBe(0);
    expect(refresh).toHaveBeenCalledOnce();
    activeExecutions.delete("active");
    activeExecutions.set("background", { turnId: "other" });
    await receive({ type: "agentSelection", selection });
    expect(setConversationSelection).toHaveBeenCalledExactlyOnceWith("active", selection);
    expect(setAgentSelection).toHaveBeenCalledExactlyOnceWith(selection);
    expect(conversationSelections.get("active")).toEqual(selection);
    expect(post).not.toHaveBeenCalled();
  });

  it("edits the addressed input, including an unpersisted running turn, without changing saved records", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    await history.addSuccess("saved prompt", [], { kind: "workflow", executions: [] }, "source", "ask", "saved");
    await history.addSuccess("other prompt", [], { kind: "workflow", executions: [] }, "other", "ask", "other-turn");
    const { sidebar, activeExecutions } = sidebarFixture(history, history.list());
    const setInput = vi.spyOn(sidebar, "setInput").mockImplementation(() => {});
    activeExecutions.set("source", { turnId: "running", source: "live prompt" });
    sidebar.editTurnInput("source", "saved");
    expect(setInput).toHaveBeenLastCalledWith("saved prompt");
    sidebar.editTurnInput("source", "running");
    expect(setInput).toHaveBeenLastCalledWith("live prompt");
    expect(() => sidebar.editTurnInput("other", "running")).toThrow("Conversation turn not found");
    expect(() => sidebar.editTurnInput("source", "other-turn")).toThrow("Conversation turn not found");
    expect(setInput).toHaveBeenCalledTimes(2);
    expect(history.list().find((session) => session.id === "source")?.turns.map((turn) => turn.input))
      .toEqual(["saved prompt"]);
  });

  it("deletes the addressed background turn without disconnecting the CLI or touching the active conversation", async () => {
    const memory = new MemoryState();
    const history = new DextHistoryStore(memory as never);
    await history.addSuccess("remove", [], { kind: "workflow", executions: [] }, "background", "ask", "turn-1");
    await history.addSuccess("keep", [], { kind: "workflow", executions: [] }, "active", "ask", "turn-2");
    const sessions = history.list();
    // Older versions could hold the first CLI ID in memory only.
    sessions[0]!.providerSessions = { codex: "thread-original" };
    const { sidebar, post, endAgentSession, activeExecutions } = sidebarFixture(history, sessions);
    activeExecutions.set("active", { turnId: "running" });
    await sidebar.deleteTurn("turn-1", "background");
    expect(sessions[0]?.turns).toEqual([]);
    expect(sessions[1]?.turns[0]?.input).toBe("keep");
    expect(endAgentSession).not.toHaveBeenCalled();
    expect(activeExecutions.has("active")).toBe(true);
    expect(post).toHaveBeenCalledWith({ type: "outputSession", session: sessions[0] });
    expect(new DextHistoryStore(memory as never).list().find((session) => session.id === "background"))
      .toMatchObject({ turns: [], providerSessions: { codex: "thread-original" } });
    await expect(sidebar.deleteTurn("turn-2", "active")).rejects.toThrow("Stop this Dext turn");
    await expect(sidebar.deleteTurn("turn-2", "background")).rejects.toThrow("Conversation turn not found");
    expect(history.list().find((session) => session.id === "active")?.turns).toHaveLength(1);
  });

  it("retries the selected History turn in its original mode and conversation", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    await history.addSuccess("original prompt", [], { kind: "workflow", executions: [] }, "source", "ask", "turn-1");
    const sessions = history.list();
    const { sidebar, activeExecutions } = sidebarFixture(history, sessions);
    const open = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn().mockResolvedValue(undefined);
    Object.assign(sidebar, { openConversation: open, run, showChat: vi.fn() });
    await sidebar.retryTurn("source", "turn-1");
    expect(open).toHaveBeenCalledWith(sessions[0]);
    expect(run).toHaveBeenCalledExactlyOnceWith("ask", "original prompt");
    activeExecutions.set("source", {});
    await expect(sidebar.retryTurn("source", "turn-1")).rejects.toThrow("Stop this Dext turn");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each((["agent", "ask", "plan", "code"] as const).flatMap((mode) => [false, true].map((fail) => ({ mode, fail }))))(
    "preserves mode and CLI binding through live replay and persistence ($mode, failure=$fail)", async ({ mode, fail }) => {
    const memory = new MemoryState();
    const history = new DextHistoryStore(memory as never);
    const session: DextHistorySession = { id: "first-session", createdAt: 1, updatedAt: 1, turns: [] };
    const { sidebar, post } = sidebarFixture(history, [session]);
    const execute = async (metadata: ExecutionMetadata) => {
      await (sidebar as unknown as { postActiveExecution(id: string, switchId: number): Promise<void> }).postActiveExecution(session.id, 77);
      metadata.onAgentSessionId?.("codex", "first-cli-thread");
      if (fail) throw new Error("execution failed");
      return { kind: "workflow" as const, executions: [] };
    };
    Object.assign(sidebar, {
      conversationSelections: new Map(),
      uiInteraction: () => undefined,
      updateRunningContext: vi.fn(),
      flushAttachmentDeletes: vi.fn().mockResolvedValue(undefined),
      application: {
        state: () => ({ agentSelection: { profileId: "codex" } }),
        agentProfiles: () => [{ id: "codex", provider: "codex" }],
        executeConversation: async (_mode: string, _input: string, metadata: ExecutionMetadata) => {
          expect(_mode).toBe(mode);
          return execute(metadata);
        },
        executeInput: async (_input: string, metadata: ExecutionMetadata) => {
          expect(mode).toBe("code");
          return execute(metadata);
        }
      }
    });
    await (sidebar as unknown as { run(mode: string, source: string): Promise<void> }).run(mode, "first prompt");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "executing", value: true, mode, source: "first prompt" }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "executing", value: true, mode, switchId: 77 }));
    const restored = new DextHistoryStore(memory as never).list()[0]!;
    expect(restored.providerSessions).toEqual({ codex: "first-cli-thread" });
    expect(restored.turns).toHaveLength(1);
    expect(restored.turns[0]?.mode).toBe(mode);
    expect(Boolean(restored.turns[0]?.error)).toBe(fail);
  });

  it.each(["codex", "claude"] as const)("resumes the same %s CLI ID after final-turn deletion and a store reload", async (provider) => {
    const memory = new MemoryState();
    const history = new DextHistoryStore(memory as never);
    await history.addSuccess("old message", [], { kind: "workflow", executions: [] }, "session", "ask", "turn");
    await history.removeTurn("session", "turn", { [provider]: "original-cli-id" });
    const restored = new DextHistoryStore(memory as never).list()[0]!;
    const calls: Array<{ args: string[]; input: string }> = [];
    const runner = new CliAgentRunner(1000, async (_command, args, input) => {
      if (args[0] === "login") return { stdout: "", stderr: "", code: 1 };
      calls.push({ args: [...args], input });
      const stdout = JSON.stringify(provider === "codex"
        ? { type: "item.completed", item: { type: "agent_message", text: "resumed" } }
        : { type: "result", result: "resumed", session_id: "original-cli-id" });
      return { stdout, stderr: "", code: 0 };
    });
    await expect(runner.runConversation({
      profile: { id: provider, provider, label: provider, command: process.execPath, models: [] },
      mode: "ask", cwd: process.cwd(), input: "continue", allowWorkspaceWrite: false, permission: "read-only",
      metadata: { agentSessionId: restored.id, conversationProviderSessionId: restored.providerSessions![provider]!, conversationContext: "Dext local history" }
    })).resolves.toBe("resumed");
    const call = calls[0]!;
    const resumeIndex = call.args.indexOf(provider === "codex" ? "resume" : "--resume");
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(call.args[resumeIndex + 1]).toBe("original-cli-id");
    expect(call.input).toBe("continue");
  });
});
