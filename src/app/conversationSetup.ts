import type { AgentProfile, AgentSelection } from "../features/agents/contracts/agent.js";
import type { ResourceDocument, ResourceSession } from "../features/resources/contracts/resourceSession.js";
import type { ConversationHistoryStore } from "../features/conversations/contracts/history.js";
import type { ConversationPreferences } from "../features/conversations/contracts/preferences.js";
import type { DextReplayEntry } from "../runner/dextResumeCache.js";
import type { SkillCommandResolution } from "../features/workflow/contracts/skill.js";
import type { ExecutionMetadata, InputExecutionResponse, RegisteredCallable } from "../shared/contracts/types.js";
import type { WebviewResponse } from "../platform/webviewProtocol.js";
import { AgentEventStream } from "../features/conversations/host/agentEventStream.js";
import { ConversationController } from "../features/conversations/host/conversationController.js";
import { InteractionController } from "../features/conversations/host/interactionController.js";
import type { InputNotificationTarget } from "../features/conversations/host/inputNotifications.js";
import { PatchReviewController } from "../features/conversations/host/patchReviewController.js";
import { PlanController } from "../features/conversations/host/planController.js";
import { TurnExecutionCoordinator } from "../features/conversations/host/turnExecutionCoordinator.js";
import { applyPatchHandler } from "../platform/vscode/patchHost.js";

/** What the sidebar still owns: Webview lifecycle, VS Code adapters and the
 * features outside this round. Everything below is passed in as a narrow
 * function, never as the sidebar or the whole application object. */
export interface ConversationSetupDependencies {
  history: ConversationHistoryStore;
  preferences: ConversationPreferences;
  post: (message: WebviewResponse) => Promise<void>;
  postWhenReady: (message: WebviewResponse) => void;
  currentSelection: () => AgentSelection;
  setAgentSelection: (selection: AgentSelection) => void;
  endAgentSession: (sessionId: string) => void;
  profiles: () => readonly AgentProfile[];
  executeConversation: (mode: "agent" | "ask" | "plan", source: string, metadata: Readonly<ExecutionMetadata>) => Promise<InputExecutionResponse>;
  executeInput: (
    source: string,
    metadata: Readonly<ExecutionMetadata>,
    run: { resume?: readonly DextReplayEntry[]; onCallLog?: (entries: readonly DextReplayEntry[]) => void }
  ) => Promise<InputExecutionResponse>;
  draftResource: (resource: ResourceSession, source: string, metadata: Readonly<ExecutionMetadata>) => Promise<{ draft: ResourceDocument; response: InputExecutionResponse }>;
  resolveSkillCommand?: (id: string, selectedSkillIds: readonly string[], args: string, agent?: string) => SkillCommandResolution;
  applyMethod: () => RegisteredCallable;
  isTrustedLocalWorkspace: () => boolean;
  readPlan: (planPath: string) => Promise<string>;
  knownPlan: (reference: string) => boolean;
  activeSessionId: () => string;
  disposed: () => boolean;
  resourceBusy: (sessionId: string) => boolean;
  notifyInput: () => PromiseLike<boolean>;
  openInputTarget: (target: InputNotificationTarget) => Promise<void>;
  postActiveExecution: (sessionId: string, switchId?: number, hostInitiated?: boolean) => Promise<void>;
  flushAttachmentDeletes: () => Promise<void>;
  /** Mirrors `dext.running` into VS Code's context keys. */
  runningChanged: () => void;
}

export interface ConversationServices {
  controller: ConversationController;
  coordinator: TurnExecutionCoordinator;
  events: AgentEventStream;
  interactions: InteractionController;
  patches: PatchReviewController;
  plans: PlanController;
  dispose(): void;
}

/** Builds the single conversation stack. Called once by the sidebar provider;
 * no second instance, subscription or timer is created for a Webview reload. */
export function createConversationServices(dependencies: ConversationSetupDependencies): ConversationServices {
  // The ports below are created before the coordinator, so they read it
  // through this holder once it exists. Nothing calls them during setup.
  const executionRef: { coordinator?: TurnExecutionCoordinator } = {};
  const controller = new ConversationController({
    history: dependencies.history,
    preferences: dependencies.preferences,
    publisher: { post: dependencies.post, postWhenReady: dependencies.postWhenReady },
    application: {
      currentSelection: dependencies.currentSelection,
      setAgentSelection: dependencies.setAgentSelection,
      endAgentSession: dependencies.endAgentSession
    },
    execution: {
      running: (sessionId) => executionRef.coordinator?.running(sessionId) ?? false,
      postActiveExecution: (sessionId, switchId, hostInitiated) => dependencies.postActiveExecution(sessionId, switchId, hostInitiated)
    }
  });
  const events = new AgentEventStream({
    activeSessionId: dependencies.activeSessionId,
    disposed: dependencies.disposed,
    post: dependencies.postWhenReady,
    observe: (sessionId, event) => interactions.observeEvent(sessionId, event)
  });
  const interactions = new InteractionController({
    notify: dependencies.notifyInput,
    open: dependencies.openInputTarget,
    turnOf: (sessionId) => executionRef.coordinator?.turnOf(sessionId),
    activeSessionId: dependencies.activeSessionId,
    disposed: dependencies.disposed
  });
  const patches = new PatchReviewController({
    post: dependencies.post,
    applyMethod: dependencies.applyMethod,
    applyPatch: applyPatchHandler
  });
  const plans = new PlanController({
    host: {
      isTrustedLocalWorkspace: dependencies.isTrustedLocalWorkspace,
      readPlan: dependencies.readPlan,
      knownPlan: dependencies.knownPlan
    },
    sessions: {
      active: () => controller.active(),
      savePlanContext: (sessionId, path, status) => controller.savePlanContext(sessionId, path, status),
      savePlanProgress: (sessionId, path, todos) => controller.savePlanProgress(sessionId, path, todos),
      postPlanContext: () => controller.postPlanContext()
    },
    running: (sessionId) => executionRef.coordinator?.running(sessionId) ?? false,
    startTurn: async (mode, source, planPath, executePlan) => {
      await coordinator.execute(controller.active(), mode, source, {
        ...(planPath !== undefined ? { planPath } : {}),
        executePlan
      });
    }
  });
  const coordinator = new TurnExecutionCoordinator({
    history: dependencies.history,
    host: {
      profiles: dependencies.profiles,
      executeConversation: dependencies.executeConversation,
      executeInput: dependencies.executeInput,
      draftResource: dependencies.draftResource,
      ...(dependencies.resolveSkillCommand ? { resolveSkillCommand: dependencies.resolveSkillCommand } : {})
    },
    sessions: controller,
    interactions,
    plans,
    patches,
    events,
    notifier: {
      started: async (snapshot) => {
        await dependencies.post({
          type: "executing",
          sessionId: snapshot.sessionId,
          value: true,
          turnId: snapshot.turnId,
          source: snapshot.source,
          startedAt: snapshot.startedAt,
          mode: snapshot.mode,
          ...(snapshot.planPath ? { planPath: snapshot.planPath } : {}),
          ...(snapshot.executePlan ? { executePlan: true } : {})
        });
        dependencies.runningChanged();
      },
      executed: async (sessionId, turnId, response, reviewPatch) => {
        await dependencies.post({
          type: "execution",
          sessionId,
          turnId,
          response,
          ...(reviewPatch ? { reviewPatch: true } : {})
        });
      },
      failed: async (sessionId, turnId, message, planOutcome) => {
        await dependencies.post({
          type: "executionFailed",
          sessionId,
          turnId,
          ...(planOutcome ? { planOutcome } : {}),
          message
        });
      },
      finished: async (sessionId, turnId) => {
        dependencies.runningChanged();
        await dependencies.post({ type: "executing", sessionId, value: false, turnId });
      }
    },
    selection: (sessionId) => controller.selection(sessionId) ?? dependencies.currentSelection(),
    resourceBusy: dependencies.resourceBusy,
    onIdle: dependencies.flushAttachmentDeletes
  });
  executionRef.coordinator = coordinator;
  return {
    controller,
    coordinator,
    events,
    interactions,
    patches,
    plans,
    dispose: () => {
      coordinator.abortAll();
      events.dispose();
      interactions.dispose();
      controller.dispose();
    }
  };
}
