import { describe, expect, it, vi } from "vitest";
import type { AgentSelection } from "../src/features/agents/contracts.js";
import type { WebviewResponse } from "../src/webviewProtocol.js";
import type { DextHistoryRecord } from "../src/features/conversations/contracts/history.js";
import type { InputExecutionResponse } from "../src/core/types.js";

const host = vi.hoisted(() => ({ executeCommand: vi.fn().mockResolvedValue(undefined) }));
vi.mock("vscode", () => ({
  commands: host,
  window: { showInformationMessage: vi.fn() },
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) }
}));

import { DextSidebarProvider } from "../src/sidebarProvider.js";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import { ConversationController } from "../src/features/conversations/host/conversationController.js";
import { conversation, createConversationHarness, defaultSelection, HarnessState } from "./conversationHarness.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const emptyResponse = (): InputExecutionResponse => ({ kind: "workflow", executions: [] });

function turn(id: string): DextHistoryRecord {
  return { id, createdAt: 1, input: "hello", process: [], output: "ok" };
}

/**
 * The sidebar still owns provider discovery and the late-menu guard, so these
 * tests drive the real provider with the real conversation controllers. Only
 * the VS Code surface is mocked.
 */
function sidebarHarness(options: {
  executeConversation?: () => Promise<InputExecutionResponse>;
} = {}) {
  const state = new HarnessState();
  const history = new DextHistoryStore(state as never);
  const preferences = new DextConversationPreferences(state as never);
  let selection: AgentSelection = { ...defaultSelection, profileId: "codex", model: "cached" };
  let models = ["cached-model"];
  const discovery = deferred();
  const storage = deferred();
  const discoverHarnessModels = vi.fn(async () => {
    await discovery.promise;
    models = ["discovered-model"];
  });
  const setAgentSelection = vi.fn((next: AgentSelection) => { selection = { ...next }; });
  const setConversationSelection = vi.fn(() => storage.promise);
  preferences.setConversationSelection = setConversationSelection as never;
  const messages: WebviewResponse[] = [];
  const application = {
    state: () => ({ agentSelection: { ...selection }, agentProfiles: [{ id: "deepseek-harness", models: [...models] }] }),
    setAgentSelection,
    endAgentSession: vi.fn(),
    agentProfiles: () => [{ id: "deepseek-harness" }],
    discoverHarnessModels,
    executeConversation: vi.fn(options.executeConversation ?? emptyResponse),
    executeInput: vi.fn(),
    draftResource: vi.fn(),
    applyMethod: vi.fn(),
    isTrustedLocalWorkspace: () => true,
    planUri: () => undefined
  };
  const sidebar = new DextSidebarProvider({} as never, application as never, history, preferences);
  Object.assign(sidebar as unknown as { post(message: WebviewResponse): Promise<void> }, {
    post: async (message: WebviewResponse) => { messages.push(message); }
  });
  const internals = sidebar as unknown as {
    receive(raw: unknown): Promise<void>;
    conversation: {
      controller: {
        hydrate(): void;
        active(): { id: string; turns: DextHistoryRecord[] };
        selection(sessionId: string): AgentSelection | undefined;
      };
      coordinator: {
        execute(session: { id: string }, mode: "agent", source: string): Promise<void>;
        running(sessionId: string): boolean;
      };
    };
  };
  internals.conversation.controller.hydrate();
  const select = (profileId: string, patch: Partial<AgentSelection> = {}) => internals.receive({
    type: "agentSelection",
    selection: {
      mode: "agent", permission: "workspace-write", profileId, model: "cached-model",
      reasoningEffort: "", speed: "", serviceTier: "", ...patch
    }
  });
  const states = () => messages.flatMap((message) => message.type === "state" ? [message.state] : []);
  return {
    internals, messages, application, discovery, storage, discoverHarnessModels,
    setAgentSelection, setConversationSelection, select, states,
    selection: () => selection
  };
}

describe("sidebar agent selection synchronization", () => {
  it("publishes and commits DeepSeek before storage and model discovery complete", async () => {
    const h = sidebarHarness();
    const request = h.select("deepseek-harness");
    await vi.waitFor(() => expect(h.states()[0]?.agentSelection.profileId).toBe("deepseek-harness"));
    expect(h.selection().profileId).toBe("deepseek-harness");
    expect(h.states()[0]?.agentProfiles[0]?.models).toEqual(["cached-model"]);
    h.storage.resolve();
    await request;
    // The handler is done even though ACP has not returned a model list.
    expect(h.discoverHarnessModels).toHaveBeenCalledOnce();
    h.discovery.resolve();
    await vi.waitFor(() => expect(h.states().at(-1)?.agentProfiles[0]?.models).toEqual(["discovered-model"]));
  });

  it("keeps the latest selection when discovery completes after switching away", async () => {
    const h = sidebarHarness();
    h.storage.resolve();
    await h.select("deepseek-harness");
    await h.select("claude");
    h.discovery.resolve();
    await vi.waitFor(() => expect(h.states()).toHaveLength(3));
    expect(h.states().at(-1)?.agentSelection.profileId).toBe("claude");
    expect(h.internals.conversation.controller.selection(h.internals.conversation.controller.active().id)?.profileId).toBe("claude");
  });

  it("shares pending discovery across rapid switches back to DeepSeek", async () => {
    const h = sidebarHarness();
    h.storage.resolve();
    await h.select("deepseek-harness");
    await h.select("codex");
    await h.select("deepseek-harness");
    expect(h.discoverHarnessModels).toHaveBeenCalledOnce();
    h.discovery.resolve();
    await vi.waitFor(() => expect(h.states().at(-1)?.agentProfiles[0]?.models).toEqual(["discovered-model"]));
  });

  it("keeps cached models and the accepted selection when discovery fails", async () => {
    const h = sidebarHarness();
    h.storage.resolve();
    await h.select("deepseek-harness");
    h.discovery.reject(new Error("ACP unavailable"));
    await vi.waitFor(() => expect(h.states()).toHaveLength(1));
    expect(h.states()[0]?.agentSelection.profileId).toBe("deepseek-harness");
    expect(h.states()[0]?.agentProfiles[0]?.models).toEqual(["cached-model"]);
    expect(h.selection().profileId).toBe("deepseek-harness");
    // A failed discovery clears the in-flight promise, so selecting Harness
    // again retries instead of staying permanently "already discovered".
    await h.select("codex");
    await h.select("deepseek-harness");
    await vi.waitFor(() => expect(h.discoverHarnessModels).toHaveBeenCalledTimes(2));
  });

  it("rejects a late agent selection while the active conversation is running", async () => {
    const gates: Array<() => void> = [];
    const h = sidebarHarness({
      executeConversation: async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return emptyResponse();
      }
    });
    const { controller, coordinator } = h.internals.conversation;
    const active = controller.active();
    h.setAgentSelection.mockClear();
    h.setConversationSelection.mockClear();
    const before = controller.selection(active.id);
    const running = coordinator.execute(active, "agent", "running");
    await vi.waitFor(() => expect(coordinator.running(active.id)).toBe(true));

    // A menu click that arrives after Send belongs to the running turn, not
    // to a new one: neither the controller nor storage may accept it.
    await h.select("claude", { model: "changed" });
    expect(controller.selection(active.id)).toEqual(before);
    expect(h.setAgentSelection).not.toHaveBeenCalled();
    expect(h.setConversationSelection).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(h.application.executeConversation).toHaveBeenCalled());
    gates.shift()!();
    await running;
  });
});

describe("conversation composer selection", () => {
  it("starts a new tab in Agent mode while keeping the provider and model it came from", async () => {
    const h = createConversationHarness();
    await h.controller.start();
    const first = h.controller.active();
    const selection = { ...defaultSelection, mode: "plan" as const, profileId: "claude", model: "sonnet" };
    h.controller.setSelection(first.id, selection);
    await h.controller.start();
    const second = h.controller.active();
    expect(h.controller.selection(second.id)).toMatchObject({ mode: "agent", profileId: "claude", model: "sonnet" });
    expect(h.preferences.conversationSelection(second.id)).toMatchObject({ mode: "agent", profileId: "claude", model: "sonnet" });
    h.dispose();
  });

  it("keeps each conversation's controls isolated when switching tabs", async () => {
    const h = createConversationHarness({ layout: { openConversationIds: ["one", "two"], activeConversationId: "one" } });
    h.seed([conversation("one", [turn("t1")]), conversation("two", [turn("t2")])]);
    const one = { ...defaultSelection, profileId: "codex", model: "one-model" };
    const two = { ...defaultSelection, profileId: "deepseek-harness", model: "two-model" };
    h.controller.setSelection("one", one);
    h.controller.setSelection("two", two);
    await h.preferences.setConversationSelection("two", two);

    h.controller.activate(h.controller.session("two")!);
    await vi.waitFor(() => expect(h.messages.at(-1)).toMatchObject({ type: "activeConversation", activeId: "two", selection: two }));
    expect(h.controller.selection("one")).toEqual(one);
    expect(h.controller.selection("two")).toEqual(two);

    h.controller.activate(h.controller.session("one")!);
    await vi.waitFor(() => expect(h.messages.at(-1)).toMatchObject({ type: "activeConversation", activeId: "one", selection: one }));
    expect(h.controller.selection("two")).toEqual(two);
    h.dispose();
  });

  it("persists the accepted provider and model so a new controller restores it", async () => {
    const h = createConversationHarness();
    await h.controller.start();
    const id = h.controller.active().id;
    const next = { ...defaultSelection, profileId: "deepseek-harness", model: "harness-model", agentPreset: "standard" };
    h.controller.setSelection(id, next);
    await h.preferences.setConversationSelection(id, next);
    await h.history.addSuccess("hello", [], emptyResponse(), id, "agent", "turn");

    const reloaded = new ConversationController({
      history: h.history,
      preferences: h.preferences,
      publisher: { post: async () => undefined, postWhenReady: () => undefined },
      application: { currentSelection: () => ({ ...defaultSelection }), setAgentSelection: vi.fn(), endAgentSession: vi.fn() },
      execution: { running: () => false, postActiveExecution: async () => undefined }
    });
    reloaded.hydrate();
    expect(reloaded.active().id).toBe(id);
    expect(reloaded.selection(id)).toEqual(next);
    reloaded.dispose();
    h.dispose();
  });
});
