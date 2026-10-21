import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent, ExecutionMetadata, InputExecutionResponse } from "../src/core/types.js";
import type { ConversationWebviewResponse } from "../src/features/conversations/contracts/protocol.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";
import { uiCallForm } from "../src/core/uiForm.js";

const host = vi.hoisted(() => ({ showInformationMessage: vi.fn(), executeCommand: vi.fn() }));
vi.mock("vscode", () => ({
  window: host,
  commands: host,
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) }
}));

import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import type { DextHistoryRecord } from "../src/features/conversations/contracts/history.js";
import { conversation, createConversationHarness, defaultSelection, HarnessState } from "./conversationHarness.js";

const waiting: AgentStreamEvent = {
  phase: "input", text: "", userInput: { id: "question", status: "waiting", blocking: false, questions: [] }
};

function turn(id: string): DextHistoryRecord {
  return { id, createdAt: 1, input: "hello", process: [], output: "ok" };
}

/** Start a turn that stays running until the test releases it. */
function gatedTurn(event?: AgentStreamEvent): {
  executeConversation: (mode: "agent" | "ask" | "plan", source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse>;
  release: () => void;
  started: () => boolean;
} {
  const gates: Array<() => void> = [];
  return {
    executeConversation: async (_mode, _source, metadata) => {
      if (event) metadata.onAgentEvent?.(event);
      await new Promise<void>((resolve) => gates.push(resolve));
      return { kind: "workflow", executions: [] };
    },
    release: () => gates.shift()?.(),
    started: () => gates.length > 0
  };
}

function harness(options: { executeConversation?: (mode: "agent" | "ask" | "plan", source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse> } = {}) {
  const h = createConversationHarness({
    layout: { openConversationIds: ["foreground", "background"], activeConversationId: "foreground" },
    ...(options.executeConversation ? { executeConversation: options.executeConversation } : {})
  });
  let choose!: (accepted: boolean) => void;
  h.notify.mockImplementation(() => new Promise<boolean>((resolve) => { choose = resolve; }));
  return {
    h,
    seed: () => h.seed([conversation("foreground", [turn("f")]), conversation("background", [turn("b")])]),
    choose: (accepted: boolean) => choose(accepted)
  };
}

/**
 * A real sidebar is only used for the two host-surface behaviours that no
 * controller owns: revealing an off-screen view, and turning the interaction
 * controller's pending focus into the `focusAgentInput` message. Conversation
 * state still comes from the real controller/coordinator stack.
 */
async function sidebarHarness(visible: boolean) {
  const state = new HarnessState();
  const history = new DextHistoryStore(state as never);
  const preferences = new DextConversationPreferences(state as never);
  for (const id of ["foreground", "background"]) {
    await history.addSuccess("hello", [], { kind: "workflow", executions: [] }, id, "agent", `turn-${id}`);
  }
  const gates: Array<() => void> = [];
  const executeConversation = vi.fn(async (_mode: string, _source: string, metadata: ExecutionMetadata): Promise<InputExecutionResponse> => {
    metadata.onAgentEvent?.(waiting);
    await new Promise<void>((resolve) => gates.push(resolve));
    return { kind: "workflow", executions: [] };
  });
  const application = {
    state: () => ({ agentSelection: { ...defaultSelection }, agentProfiles: [] }),
    setAgentSelection: vi.fn(),
    endAgentSession: vi.fn(),
    agentProfiles: () => [],
    executeConversation,
    executeInput: vi.fn(),
    draftResource: vi.fn(),
    applyMethod: vi.fn(),
    isTrustedLocalWorkspace: () => true,
    planUri: () => undefined
  };
  const messages: WebviewResponse[] = [];
  const sidebar = new DextSidebarProvider({} as never, application as never, history, preferences);
  const internals = sidebar as unknown as {
    view: { visible: boolean; webview: { postMessage(message: WebviewResponse): Promise<boolean> } };
    messageQueue: { markReady(): void };
    conversation: {
      controller: { hydrate(): void; activate(session: unknown): void; session(id: string): unknown };
      coordinator: { execute(session: unknown, mode: "agent", source: string): Promise<void>; running(id: string): boolean; turnOf(id: string): string | undefined };
    };
  };
  internals.view = {
    visible,
    webview: { postMessage: async (message) => { messages.push(message); return true; } }
  };
  internals.messageQueue.markReady();
  internals.conversation.controller.hydrate();
  internals.conversation.controller.activate(internals.conversation.controller.session("foreground"));
  let choose!: (action?: string) => void;
  host.showInformationMessage.mockImplementation(() => new Promise<string | undefined>((resolve) => { choose = resolve; }));
  return {
    internals, messages, executeConversation, gates,
    choose: (action: string) => choose(action),
    release: () => gates.shift()?.()
  };
}

describe("sidebar input notifications", () => {
  beforeEach(() => vi.resetAllMocks());

  it("notifies for a background question, opens it only on user action, and hands focus to that conversation", async () => {
    const gate = gatedTurn(waiting);
    const { h, seed, choose } = harness({ executeConversation: gate.executeConversation });
    seed();
    const background = h.controller.session("background")!;

    const execution = h.coordinator.execute(background, "agent", "background question");
    await vi.waitFor(() => expect(h.coordinator.running("background")).toBe(true));
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
    const turnId = h.coordinator.turnOf("background")!;
    const target = { sessionId: "background", turnId, requestId: "question", kind: "agent" as const };

    // A background conversation keeps its events in the execution snapshot;
    // only the active tab may receive agent event batches.
    expect(h.open).not.toHaveBeenCalled();
    expect(h.messages.some((message) => (message.type === "agentEvent" || message.type === "agentEvents") && message.sessionId === "background")).toBe(false);
    expect(h.interactions.isWaiting(target)).toBe(true);

    choose(true);
    await vi.waitFor(() => expect(h.open).toHaveBeenCalledWith(target));

    // The sidebar records the target, then activates the conversation. Focus
    // is handed off only once that conversation is the visible one, and only
    // while the question is still waiting.
    h.interactions.requestFocus(target);
    expect(h.interactions.pendingFocus("background", turnId)).toBeUndefined();
    h.controller.activate(background);
    expect(h.interactions.pendingFocus("background", turnId)).toEqual(target);
    expect(h.interactions.pendingFocus("background", turnId)).toBeUndefined();

    await vi.waitFor(() => expect(gate.started()).toBe(true));
    gate.release();
    await execution;
    expect(h.interactions.isWaiting(target)).toBe(false);
    h.dispose();
  });

  it("does not notify twice for one UI form and ignores an answered one", async () => {
    const gate = gatedTurn();
    const { h, seed, choose } = harness({ executeConversation: gate.executeConversation });
    seed();
    const execution = h.coordinator.execute(h.controller.session("background")!, "agent", "ui question");
    await vi.waitFor(() => expect(h.coordinator.running("background")).toBe(true));
    const turnId = h.coordinator.turnOf("background")!;
    const uiInteraction = {
      sessionId: "background", turnId, requestId: "form", status: "waiting" as const,
      form: uiCallForm("confirm", { message: "Choice", presentation: "inline" })
    };
    const target = { sessionId: "background", turnId, requestId: "form", kind: "ui" as const };

    h.interactions.observeEvent("background", { phase: "input", text: "", uiInteraction });
    h.interactions.observeEvent("background", { phase: "input", text: "", uiInteraction });
    expect(h.notify).toHaveBeenCalledOnce();
    h.interactions.observeEvent("background", { phase: "input", text: "", uiInteraction: { ...uiInteraction, status: "closed" } });
    expect(h.interactions.isWaiting(target)).toBe(false);

    choose(true);
    await Promise.resolve();
    expect(h.open).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(gate.started()).toBe(true));
    gate.release();
    await execution;
    h.dispose();
  });

  it("does not navigate if the turn ends while the notification is being accepted", async () => {
    const gate = gatedTurn(waiting);
    const { h, seed, choose } = harness({ executeConversation: gate.executeConversation });
    seed();
    const execution = h.coordinator.execute(h.controller.session("background")!, "agent", "background question");
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledOnce());
    const turnId = h.coordinator.turnOf("background")!;
    const target = { sessionId: "background", turnId, requestId: "question", kind: "agent" as const };

    // The turn finishing clears its pending questions before a delayed toast
    // action can restore it.
    await vi.waitFor(() => expect(gate.started()).toBe(true));
    gate.release();
    await execution;
    expect(h.coordinator.running("background")).toBe(false);
    expect(h.interactions.isWaiting(target)).toBe(false);

    choose(true);
    await Promise.resolve();
    expect(h.open).not.toHaveBeenCalled();
    h.dispose();
  });

  it.each([false, true])("reveals Dext only when it is not already on screen (visible: %s)", async (visible) => {
    const h = await sidebarHarness(visible);
    const background = h.internals.conversation.controller.session("background")!;
    const execution = h.internals.conversation.coordinator.execute(background, "agent", "background question");
    await vi.waitFor(() => expect(h.internals.conversation.coordinator.running("background")).toBe(true));
    await vi.waitFor(() => expect(host.showInformationMessage).toHaveBeenCalledOnce());
    const turnId = h.internals.conversation.coordinator.turnOf("background")!;

    h.choose("View question");
    await vi.waitFor(() => expect(h.messages.some((message): message is ConversationWebviewResponse & { type: "focusAgentInput" } =>
      message.type === "focusAgentInput" && message.sessionId === "background"
      && message.turnId === turnId && message.requestId === "question" && message.kind === "agent"
    )).toBe(true));

    // Asking the host to focus a view that is already on screen rewrites the
    // reader's layout (a maximized Secondary Side Bar loses its width), so an
    // on-screen Dext must keep its display state. Coordinator notifier calls
    // also use executeCommand for context keys, so look for the reveal itself.
    const focused = host.executeCommand.mock.calls.some(([command]) => command === "dext.sidebar.focus");
    expect(focused).toBe(!visible);
    expect(h.messages.some((message) => message.type === "activeConversation" && message.activeId === "background")).toBe(true);
    // The buffered events are restored before the focus hand-off, so the
    // revealed question is on screen when the Webview tries to focus it.
    const executing = h.messages.findIndex((message) => message.type === "executing" && message.sessionId === "background" && message.value);
    const restored = h.messages.findIndex((message) => message.type === "agentEvents" && message.sessionId === "background");
    const focus = h.messages.findIndex((message) => message.type === "focusAgentInput" && message.sessionId === "background");
    expect(executing).toBeGreaterThanOrEqual(0);
    expect(restored).toBeGreaterThan(executing);
    expect(focus).toBeGreaterThan(restored);

    await vi.waitFor(() => expect(h.executeConversation).toHaveBeenCalled());
    h.release();
    await execution;
  });
});
