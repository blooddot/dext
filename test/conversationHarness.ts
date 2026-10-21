import { vi } from "vitest";
import type { AgentProfile, AgentSelection } from "../src/features/agents/contracts.js";
import type { ConversationHistoryStore, DextHistorySession } from "../src/features/conversations/contracts/history.js";
import type { ConversationLayout } from "../src/features/conversations/contracts/preferences.js";
import type { ConversationWebviewResponse } from "../src/features/conversations/contracts/protocol.js";
import { DextHistoryStore } from "../src/features/conversations/host/historyStore.js";
import { DextConversationPreferences } from "../src/features/conversations/host/conversationPreferences.js";
import { AgentEventStream } from "../src/features/conversations/host/agentEventStream.js";
import { ConversationController } from "../src/features/conversations/host/conversationController.js";
import { InteractionController } from "../src/features/conversations/host/interactionController.js";
import { PatchReviewController } from "../src/features/conversations/host/patchReviewController.js";
import { PlanController } from "../src/features/conversations/host/planController.js";
import { TurnExecutionCoordinator } from "../src/features/conversations/host/turnExecutionCoordinator.js";
import type { ExecutionMetadata, InputExecutionResponse, RegisteredCallable } from "../src/core/types.js";
import type { ResourceDocument, ResourceSession } from "../src/features/resources/contracts/resourceSession.js";
import type { DextReplayEntry } from "../src/runner/dextResumeCache.js";

/** A shared in-memory memento for controllers and preferences. */
export class HarnessState {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string, fallback: T): T {
    return (this.values.has(key) ? this.values.get(key) as T : fallback);
  }
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

export const defaultSelection: AgentSelection = {
  mode: "agent",
  permission: "workspace-write",
  profileId: "codex",
  model: "model",
  reasoningEffort: "",
  speed: "",
  serviceTier: ""
};

export interface ConversationHarnessOptions {
  profiles?: AgentProfile[];
  sessions?: DextHistorySession[];
  layout?: Partial<ConversationLayout>;
  pinned?: string[];
  selection?: Partial<AgentSelection>;
  executeConversation?: (mode: "agent" | "ask" | "plan", source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse>;
  executeInput?: (source: string, metadata: Readonly<ExecutionMetadata>, run: { resume?: readonly DextReplayEntry[]; onCallLog?: (entries: readonly DextReplayEntry[]) => void }) => Promise<InputExecutionResponse>;
  draftResource?: (resource: ResourceSession, source: string, metadata: Readonly<ExecutionMetadata>) => Promise<{ draft: ResourceDocument; response: InputExecutionResponse }>;
  planText?: string;
  trusted?: boolean;
  running?: (sessionId: string) => boolean;
}

/** Builds the real conversation stack for tests: controller, coordinator, plan
 * and patch controllers, event stream and interactions, with no VS Code. */
export function createConversationHarness(options: ConversationHarnessOptions = {}) {
  const state = new HarnessState();
  const history = new DextHistoryStore(state as never);
  const preferences = new DextConversationPreferences(state as never);
  if (options.layout) void preferences.setConversationLayout({ openConversationIds: [], ...options.layout });
  for (const sessionId of options.pinned ?? []) void preferences.setPinned(sessionId, true);
  const messages: ConversationWebviewResponse[] = [];
  const post = async (message: ConversationWebviewResponse): Promise<void> => {
    messages.push(structuredClone(message));
  };
  const postWhenReady = (message: ConversationWebviewResponse): void => {
    messages.push(structuredClone(message));
  };
  const selection = { ...defaultSelection, ...options.selection };
  const open = vi.fn(async () => undefined);
  const notify = vi.fn(async () => true);
  const executeConversation = vi.fn(options.executeConversation ?? (async (): Promise<InputExecutionResponse> => ({ kind: "workflow", executions: [] })));
  const executeInput = vi.fn(options.executeInput ?? (async (): Promise<InputExecutionResponse> => ({ kind: "workflow", executions: [] })));
  const draftResource = vi.fn(options.draftResource ?? (async (): Promise<{ draft: ResourceDocument; response: InputExecutionResponse }> => ({
    draft: { name: "draft", content: "" },
    response: { kind: "workflow", executions: [] }
  })));
  const applyMethod = vi.fn((): RegisteredCallable => {
    throw new Error("no apply method in this test");
  });
  const executionRef: { coordinator?: TurnExecutionCoordinator } = {};
  const controller = new ConversationController({
    history,
    preferences,
    publisher: { post, postWhenReady },
    application: {
      currentSelection: () => selection,
      setAgentSelection: vi.fn(),
      endAgentSession: vi.fn()
    },
    execution: {
      running: (sessionId) => executionRef.coordinator?.running(sessionId) ?? false,
      postActiveExecution: vi.fn(async () => undefined)
    }
  });
  const events = new AgentEventStream({
    activeSessionId: () => controller.active().id,
    disposed: () => false,
    post: postWhenReady,
    observe: (sessionId, event) => interactions.observeEvent(sessionId, event),
    flushDelayMs: 0
  });
  const interactions = new InteractionController({
    notify,
    open,
    turnOf: (sessionId) => executionRef.coordinator?.turnOf(sessionId),
    activeSessionId: () => controller.active().id,
    disposed: () => false
  });
  const patches = new PatchReviewController({
    post,
    applyMethod,
    applyPatch: vi.fn(() => {
      throw new Error("no apply handler in this test");
    })
  });
  const plans = new PlanController({
    host: {
      isTrustedLocalWorkspace: () => options.trusted ?? true,
      readPlan: async () => options.planText ?? "",
      knownPlan: () => true
    },
    sessions: {
      active: () => controller.active(),
      savePlanContext: (sessionId, path, status) => controller.savePlanContext(sessionId, path, status),
      savePlanProgress: (sessionId, path, todos) => controller.savePlanProgress(sessionId, path, todos),
      postPlanContext: () => controller.postPlanContext()
    },
    running: (sessionId) => executionRef.coordinator?.running(sessionId) ?? false,
    startTurn: (mode, source, planPath, executePlan) => executionRef.coordinator!.execute(controller.active(), mode, source, {
      ...(planPath !== undefined ? { planPath } : {}),
      executePlan
    })
  });
  const coordinator = new TurnExecutionCoordinator({
    history,
    host: {
      profiles: () => options.profiles ?? [],
      executeConversation,
      executeInput,
      draftResource
    },
    sessions: controller,
    interactions,
    plans,
    patches,
    events,
    notifier: {
      started: async (snapshot) => {
        messages.push({
          type: "executing",
          sessionId: snapshot.sessionId,
          value: true,
          turnId: snapshot.turnId,
          source: snapshot.source,
          mode: snapshot.mode,
          startedAt: snapshot.startedAt,
          ...(snapshot.planPath ? { planPath: snapshot.planPath } : {}),
          ...(snapshot.executePlan ? { executePlan: true } : {})
        });
      },
      executed: async (sessionId, turnId, response, reviewPatch) => {
        messages.push({ type: "execution", sessionId, turnId, response, ...(reviewPatch ? { reviewPatch: true } : {}) });
      },
      failed: async (sessionId, turnId, message, planOutcome) => {
        messages.push({ type: "executionFailed", sessionId, turnId, message, ...(planOutcome ? { planOutcome } : {}) });
      },
      finished: async (sessionId, turnId) => {
        messages.push({ type: "executing", sessionId, value: false, turnId });
      }
    },
    selection: (sessionId) => controller.selection(sessionId) ?? selection,
    resourceBusy: () => false
  });
  executionRef.coordinator = coordinator;

  /** Stores sessions, then hydrates the controller so they become the tabs. */
  function seed(sessions: readonly DextHistorySession[]): void {
    const stored = state.get<DextHistorySession[]>("dext.history", []);
    const ids = new Set(sessions.map((session) => session.id));
    state.set("dext.history", [
      ...stored.filter((session) => !ids.has(session.id)),
      ...sessions.map((session) => structuredClone(session))
    ]);
    // Without an explicit layout, seed the tabs the test just created so they
    // are open and the last one is active.
    if (!options.layout && sessions.length) {
      void preferences.setConversationLayout({
        openConversationIds: sessions.map((session) => session.id),
        activeConversationId: sessions.at(-1)!.id
      });
    }
    controller.hydrate();
  }

  return {
    state, history, preferences, controller, coordinator, plans, patches, interactions, events,
    messages, post, postWhenReady, executeConversation, executeInput, draftResource, applyMethod, open, notify, seed,
    dispose: () => {
      events.dispose();
      interactions.dispose();
      controller.dispose();
    }
  };
}

/** A stored conversation with a deterministic id and timestamps. */
export function conversation(id: string, turns: DextHistorySession["turns"] = []): DextHistorySession {
  return { id, createdAt: 1, updatedAt: turns.at(-1)?.createdAt ?? 1, turns };
}

/** Seeds stored sessions into a harness history without going through turns. */
export async function seedHistory(history: ConversationHistoryStore, sessions: readonly DextHistorySession[]): Promise<void> {
  for (const session of sessions) {
    for (const turn of session.turns) {
      await history.addSuccess(turn.input, turn.process, turn.response ?? { kind: "workflow", executions: [] }, session.id, turn.mode, turn.id);
    }
    if (session.activePlanPath || session.planStatus) await history.updatePlanContext(session.id, session.activePlanPath, session.planStatus ?? "new");
    if (session.resource) await history.updateResourceContext(session.id, session.resource);
  }
}
