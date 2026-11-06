import { describe, expect, it, vi } from "vitest";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import type { DextHistorySession } from "../src/features/conversations/contracts/history.js";
import type { AgentSelection } from "../src/features/agents/contracts/agent.js";
import { DextSidebarProvider } from "../src/app/sidebarProvider.js";
import { CliAgentRunner } from "../src/features/agents/host/agentRunner.js";
import type { ExecutionMetadata } from "../src/shared/contracts/types.js";
import type { WebviewResponse } from "../src/platform/webviewProtocol.js";

const host = vi.hoisted(() => ({ executeCommand: vi.fn().mockResolvedValue(undefined), showInformationMessage: vi.fn() }));
vi.mock("vscode", () => ({ commands: host, window: host }));

class MemoryState {
  private values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T { return this.values.has(key) ? this.values.get(key) as T : fallback; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

const selection: AgentSelection = {
  mode: "agent", permission: "workspace-write", profileId: "codex", model: "model",
  reasoningEffort: "", speed: "", serviceTier: ""
};

function sidebarFixture(options: {
  history: DextHistoryStore;
  preferences?: DextConversationPreferences;
  application?: Record<string, unknown>;
} ) {
  const messages: WebviewResponse[] = [];
  const application = {
    state: () => ({ agentSelection: selection }),
    setAgentSelection: vi.fn(),
    endAgentSession: vi.fn(),
    agentProfiles: () => [],
    ...options.application
  };
  const preferences = options.preferences ?? new DextConversationPreferences(new MemoryState() as never);
  const sidebar = new DextSidebarProvider({} as never, application as never, options.history, preferences);
  const internals = sidebar as unknown as {
    view?: unknown;
    messageQueue: { markReady(): WebviewResponse[] };
    post(message: WebviewResponse): Promise<void>;
    receive(message: unknown): Promise<void>;
    run(mode: string, source: string): Promise<void>;
    postActiveExecution(sessionId: string, switchId?: number): Promise<void>;
  };
  internals.view = { webview: { postMessage: async (message: WebviewResponse) => { messages.push(message); } } };
  internals.messageQueue.markReady();
  return { sidebar, application, preferences, messages, internals };
}

describe("shared History and Conversation actions", () => {
  it("keeps an existing conversation's Harness preset when a late selection arrives", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    await history.addSuccess("hello", [], { kind: "workflow", executions: [] }, "active", "agent", "turn");
    const preferences = new DextConversationPreferences(new MemoryState() as never);
    const sidebar = new DextSidebarProvider({} as never, {
      state: () => ({ agentSelection: { ...selection, profileId: "deepseek-harness", agentPreset: "standard" } }),
      setAgentSelection: vi.fn(), endAgentSession: vi.fn(), agentProfiles: () => []
    } as never, history, preferences);
    const controller = (sidebar as unknown as { conversation: { controller: { hydrate(): void; open(session: DextHistorySession): Promise<void>; selection(id: string): AgentSelection | undefined } } }).conversation.controller;
    controller.hydrate();
    await controller.open(history.list()[0]!);
    expect(controller.selection("active")?.agentPreset).toBe("standard");
    const setConversationSelection = vi.spyOn(preferences, "setConversationSelection");
    await (sidebar as unknown as { receive(message: unknown): Promise<void> }).receive({
      type: "agentSelection",
      selection: { mode: "agent", permission: "workspace-write", profileId: "deepseek-harness", model: "model", reasoningEffort: "", speed: "", serviceTier: "", agentPreset: "ptc" }
    });
    expect(setConversationSelection).not.toHaveBeenCalled();
    expect(controller.selection("active")?.agentPreset).toBe("standard");
  });

  it("rejects late configuration changes while this conversation runs and unlocks independently of background runs", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    await history.addSuccess("prompt", [], { kind: "workflow", executions: [] }, "active", "agent", "turn");
    await history.addSuccess("other", [], { kind: "workflow", executions: [] }, "background", "agent", "turn-2");
    const setAgentSelection = vi.fn();
    const setConversationSelection = vi.fn().mockResolvedValue(undefined);
    const preferences = new DextConversationPreferences(new MemoryState() as never);
    preferences.setConversationSelection = setConversationSelection;
    let releaseActive!: () => void;
    const executeConversation = vi.fn(async () => {
      await new Promise<void>((resolve) => { releaseActive = resolve; });
      return { kind: "workflow" as const, executions: [] };
    });
    const fixture = sidebarFixture({ history, preferences, application: { setAgentSelection, executeConversation } });
    const { sidebar, internals } = fixture;
    const provider = sidebar as unknown as {
      conversation: {
        controller: { hydrate(): void; session(id: string): DextHistorySession | undefined; active(): DextHistorySession; activate(session: DextHistorySession): void; selection(id: string): AgentSelection | undefined };
        coordinator: { running(id: string): boolean; execute(session: DextHistorySession, mode: string, source: string): Promise<void> };
      };
    };
    provider.conversation.controller.hydrate();
    const active = provider.conversation.controller.session("active")!;
    const background = provider.conversation.controller.session("background")!;
    provider.conversation.controller.activate(active);
    // Activation itself may persist the tab's selection; the late-click guard
    // is about what happens while that conversation runs.
    setConversationSelection.mockClear();
    setAgentSelection.mockClear();
    const activeTurn = provider.conversation.coordinator.execute(active, "agent", "running prompt");
    await vi.waitFor(() => expect(provider.conversation.coordinator.running("active")).toBe(true));
    const runSelection = { mode: "plan", permission: "full-access", profileId: "codex", model: "new-model", reasoningEffort: "high", speed: "", serviceTier: "" } as const;

    expect(provider.conversation.controller.active().id).toBe("active");
    expect((sidebar as unknown as { running(id: string): boolean }).running("active")).toBe(true);
    await internals.receive({ type: "agentSelection", selection: runSelection });
    expect(setConversationSelection).not.toHaveBeenCalled();
    expect(setAgentSelection).not.toHaveBeenCalled();
    expect(provider.conversation.controller.selection("active")?.model).toBe("model");

    releaseActive();
    await activeTurn;
    const backgroundTurn = provider.conversation.coordinator.execute(background, "agent", "background prompt");
    await vi.waitFor(() => expect(provider.conversation.coordinator.running("background")).toBe(true));
    await internals.receive({ type: "agentSelection", selection: runSelection });
    expect(setConversationSelection).toHaveBeenCalledExactlyOnceWith("active", runSelection);
    expect(setAgentSelection).toHaveBeenCalledExactlyOnceWith(runSelection);
    expect(provider.conversation.controller.selection("active")).toEqual(runSelection);
    releaseActive();
    await backgroundTurn;
  });

  it("edits the addressed input, including an unpersisted running turn, without changing saved records", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    await history.addSuccess("saved prompt", [], { kind: "workflow", executions: [] }, "source", "ask", "saved");
    await history.addSuccess("other prompt", [], { kind: "workflow", executions: [] }, "other", "ask", "other-turn");
    const { sidebar } = sidebarFixture({ history });
    const provider = sidebar as unknown as {
      conversation: { controller: { hydrate(): void }; coordinator: { active(id: string): unknown } };
    };
    provider.conversation.controller.hydrate();
    vi.spyOn(provider.conversation.coordinator, "active").mockImplementation((sessionId: string) =>
      sessionId === "source" ? { turnId: "running", source: "live prompt" } : undefined);
    const setInput = vi.spyOn(sidebar, "setInput").mockImplementation(() => {});
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
    // Older versions could hold the first CLI ID in memory only.
    await history.setProviderSession("background", "codex", "thread-original");
    const { sidebar, messages, application } = sidebarFixture({ history });
    const provider = sidebar as unknown as { conversation: { controller: { hydrate(): void; session(id: string): DextHistorySession | undefined } } };
    provider.conversation.controller.hydrate();
    await sidebar.deleteTurn("turn-1", "background");
    expect(provider.conversation.controller.session("background")?.turns).toEqual([]);
    expect(provider.conversation.controller.session("active")?.turns[0]?.input).toBe("keep");
    expect(application.endAgentSession).not.toHaveBeenCalled();
    expect(messages).toContainEqual(expect.objectContaining({ type: "outputSession" }));
    expect(new DextHistoryStore(memory as never).list().find((session) => session.id === "background"))
      .toMatchObject({ turns: [], providerSessions: { codex: "thread-original" } });
    await expect(sidebar.deleteTurn("turn-2", "background")).rejects.toThrow("Conversation turn not found");
    const running = vi.spyOn((sidebar as unknown as { conversation: { coordinator: { running(id: string): boolean } } }).conversation.coordinator, "running").mockReturnValue(true);
    await expect(sidebar.deleteTurn("turn-2", "active")).rejects.toThrow("Stop this Dext turn");
    running.mockRestore();
    expect(history.list().find((session) => session.id === "active")?.turns).toHaveLength(1);
  });

  it("retries the selected History turn in its original mode and conversation", async () => {
    const history = new DextHistoryStore(new MemoryState() as never);
    await history.addSuccess("original prompt", [], { kind: "workflow", executions: [] }, "source", "ask", "turn-1");
    const sessions = history.list();
    const { sidebar } = sidebarFixture({ history });
    const provider = sidebar as unknown as {
      conversation: { controller: { hydrate(): void }; coordinator: { running(id: string): boolean } };
      openConversation(session: DextHistorySession): Promise<void>;
      run(mode: string, source: string): Promise<void>;
    };
    provider.conversation.controller.hydrate();
    const open = vi.spyOn(sidebar, "openConversation").mockResolvedValue(undefined);
    const run = vi.spyOn(provider as unknown as { run(mode: string, source: string): Promise<void> }, "run").mockResolvedValue(undefined);
    await sidebar.retryTurn("source", "turn-1");
    expect(open).toHaveBeenCalledWith(sessions[0]);
    expect(run).toHaveBeenCalledExactlyOnceWith("ask", "original prompt");
    vi.spyOn(provider.conversation.coordinator, "running").mockReturnValue(true);
    await expect(sidebar.retryTurn("source", "turn-1")).rejects.toThrow("Stop this Dext turn");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each((["agent", "ask", "plan", "code"] as const).flatMap((mode) => [false, true].map((fail) => ({ mode, fail }))))(
    "preserves mode and CLI binding through live replay and persistence ($mode, failure=$fail)", async ({ mode, fail }) => {
    const memory = new MemoryState();
    const history = new DextHistoryStore(memory as never);
    const session: DextHistorySession = { id: "first-session", createdAt: 1, updatedAt: 1, turns: [] };
    const execute = async (metadata: ExecutionMetadata) => {
      await (sidebar as unknown as { postActiveExecution(id: string, switchId: number): Promise<void> }).postActiveExecution(session.id, 77);
      metadata.onAgentSessionId?.("codex", "first-cli-thread");
      if (fail) throw new Error("execution failed");
      return { kind: "workflow" as const, executions: [] };
    };
    const { sidebar, messages } = sidebarFixture({
      history,
      application: {
        agentProfiles: () => [{ id: "codex", provider: "codex" }],
        executeConversation: async (requestedMode: string, _input: string, metadata: ExecutionMetadata) => {
          expect(requestedMode).toBe(mode);
          return execute(metadata);
        },
        executeInput: async (_input: string, metadata: ExecutionMetadata) => {
          expect(mode).toBe("code");
          expect(metadata.agentPermission).toBe("full-access");
          return execute(metadata);
        }
      }
    });
    const provider = sidebar as unknown as {
      conversation: {
        controller: { hydrate(): void; open(session: DextHistorySession): Promise<void>; active(): DextHistorySession };
        coordinator: { execute(session: DextHistorySession, mode: string, source: string): Promise<void> };
      };
    };
    provider.conversation.controller.hydrate();
    await provider.conversation.controller.open(history.list()[0] ?? session);
    await provider.conversation.coordinator.execute(provider.conversation.controller.active(), mode, "first prompt");
    expect(messages).toContainEqual(expect.objectContaining({ type: "executing", value: true, mode, source: "first prompt" }));
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
