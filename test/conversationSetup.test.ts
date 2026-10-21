import { describe, expect, it, vi } from "vitest";
import type { AgentSelection } from "../src/features/agents/contracts.js";
import type { ExecutionMetadata, InputExecutionResponse } from "../src/core/types.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import { createConversationServices } from "../src/app/conversationSetup.js";
import { HarnessState, conversation, defaultSelection } from "./conversationHarness.js";

vi.mock("vscode", () => ({}));

function services(options: { executeConversation?: (mode: "agent" | "ask" | "plan", source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse> } = {}) {
  const state = new HarnessState();
  state.set("dext.history", [conversation("session")]);
  const history = new DextHistoryStore(state as never);
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
    applyMethod: () => { throw new Error("no apply"); },
    isTrustedLocalWorkspace: () => true,
    readPlan: async () => "",
    knownPlan: () => true,
    activeSessionId: () => ref.services!.controller.active().id,
    disposed: () => false,
    resourceBusy: () => false,
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
    controller.hydrate();
    const session = controller.session("session")!;
    controller.activate(session);
    await h.services.coordinator.execute(controller.active(), "agent", "hello");
    expect(h.executeConversation).toHaveBeenCalledOnce();
    expect(h.posted).toContainEqual(expect.objectContaining({ type: "executing", value: true, source: "hello" }));
    expect(h.posted).toContainEqual(expect.objectContaining({ type: "execution" }));
    expect(h.posted).toContainEqual(expect.objectContaining({ type: "executing", value: false }));
    expect(h.runningChanged).toHaveBeenCalled();
    expect(h.history.list()[0]?.turns[0]?.input).toBe("hello");
    // The same controller instance owns the conversation for plan and patch work.
    expect(h.services.plans).toBeDefined();
    expect(h.services.patches).toBeDefined();
    expect(h.services.interactions).toBeDefined();
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
    h.services.controller.hydrate();
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
