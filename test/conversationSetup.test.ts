import { describe, expect, it, vi } from "vitest";
import type { AgentSelection } from "../src/features/agents/contracts/agent.js";
import type { ExecutionMetadata, InputExecutionResponse } from "../src/shared/contracts/types.js";
import type { WebviewResponse } from "../src/platform/webviewProtocol.js";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { MemoryHistoryBackend } from "./historyBackend.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import { createConversationServices } from "../src/app/conversationSetup.js";
import { HarnessState, conversation, defaultSelection } from "./conversationHarness.js";

vi.mock("vscode", () => ({}));

function services(options: { executeConversation?: (mode: "agent" | "ask" | "plan", source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse>; changedFiles?: (since: number, sessionId: string, turnId: string, written: readonly string[]) => Promise<string[] | undefined>; turnStarted?: (turnId: string) => void } = {}) {
  const state = new HarnessState();
  const history = new DextHistoryStore(new MemoryHistoryBackend({ sessions: [conversation("session")] }));
  const preferences = new DextConversationPreferences(state as never);
  const posted: WebviewResponse[] = [];
  const selection: AgentSelection = { ...defaultSelection };
  const executeConversation = vi.fn(options.executeConversation ?? (async (): Promise<InputExecutionResponse> => ({ kind: "workflow", executions: [] })));
  const runningChanged = vi.fn();
  const ref: { services?: ReturnType<typeof createConversationServices> } = {};
  const deps = {
    history,
    preferences,
    post: async (message: WebviewResponse) => { posted.push(message); },
    postWhenReady: (message: WebviewResponse) => { posted.push(message); },
    currentSelection: () => selection,
    setAgentSelection: vi.fn(),
    endAgentSession: vi.fn(),
    profiles: () => [],
    executeConversation,
    executeInput: vi.fn(async (): Promise<InputExecutionResponse> => ({ kind: "workflow", executions: [] })),
    draftResource: vi.fn(),
    isTrustedLocalWorkspace: () => true,
    readPlan: async () => "",
    knownPlan: () => true,
    activeSessionId: () => ref.services!.controller.active().id,
    disposed: () => false,
    resourceBusy: () => false,
    ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}),
    ...(options.turnStarted ? { turnStarted: options.turnStarted } : {}),
    notifyInput: async () => false,
    openInputTarget: async () => undefined,
    postActiveExecution: async () => undefined,
    flushAttachmentDeletes: async () => undefined,
    runningChanged
  };
  const services = createConversationServices(deps as never);
  ref.services = services;
  return { services, history, posted, executeConversation, runningChanged, deps };
}

describe("createConversationServices", () => {
  it("creates one stack and runs a turn through the host ports", async () => {
    const h = services();
    const controller = h.services.controller;
    await controller.hydrate();
    const session = controller.session("session")!;
    controller.activate(session);
    await h.services.coordinator.execute(controller.active(), "agent", "hello");
    expect(h.executeConversation).toHaveBeenCalledOnce();
    expect(h.posted).toContainEqual(expect.objectContaining({ type: "executing", value: true, source: "hello" }));
    expect(h.posted).toContainEqual(expect.objectContaining({ type: "execution" }));
    expect(h.posted).toContainEqual(expect.objectContaining({ type: "executing", value: false }));
    expect(h.runningChanged).toHaveBeenCalled();
    expect((await h.history.sessions())[0]?.turns[0]?.input).toBe("hello");
    // The same controller instance owns the conversation for plan and patch work.
    expect(h.services.plans).toBeDefined();
    expect(h.services).not.toHaveProperty("patches");
    expect(h.services.interactions).toBeDefined();
  });

  it("hands a finished turn's changed files to the live row", async () => {
    const h = services({ changedFiles: async () => ["src/a.ts"] });
    await h.services.controller.hydrate();
    h.services.controller.activate(h.services.controller.session("session")!);
    await h.services.coordinator.execute(h.services.controller.active(), "agent", "edit a");
    // The live row never reads a stored record, so the end of the turn carries
    // the paths and the reasons the record already explains.
    expect(h.posted).toContainEqual(expect.objectContaining({
      type: "executing",
      value: false,
      changes: [{ path: "src/a.ts", reason: "no stated reason" }]
    }));
  });

  it("takes a workspace baseline before the turn and hands it the turn's own writes", async () => {
    const changedFiles = vi.fn<(since: number, sessionId: string, turnId: string, written: readonly string[]) => Promise<string[] | undefined>>(async () => ["src/a.ts"]);
    const turnStarted = vi.fn();
    const h = services({
      changedFiles,
      turnStarted,
      executeConversation: async (_mode, _source, metadata): Promise<InputExecutionResponse> => {
        metadata.onAgentEvent?.({ id: "w", phase: "tool", text: "", files: ["src/a.ts"] });
        return { kind: "workflow", executions: [] };
      }
    });
    await h.services.controller.hydrate();
    h.services.controller.activate(h.services.controller.session("session")!);
    await h.services.coordinator.execute(h.services.controller.active(), "agent", "edit a");
    expect(turnStarted).toHaveBeenCalledOnce();
    expect(changedFiles.mock.calls[0]?.[1]).toBe("session");
    expect(changedFiles.mock.calls[0]?.[3]).toEqual(["src/a.ts"]);
  });

  it("releases a running turn when the services are disposed", async () => {
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const h = services({
      executeConversation: async (_mode, _source, metadata): Promise<InputExecutionResponse> => {
        if (metadata.signal) signals.push(metadata.signal);
        await new Promise<void>((resolve) => { release = resolve; });
        return { kind: "workflow", executions: [] };
      }
    });
    await h.services.controller.hydrate();
    const session = h.services.controller.session("session")!;
    h.services.controller.activate(session);
    const turn = h.services.coordinator.execute(h.services.controller.active(), "agent", "long");
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    h.services.dispose();
    expect(signals[0]?.aborted).toBe(true);
    release();
    await turn.catch(() => undefined);
  });
});
