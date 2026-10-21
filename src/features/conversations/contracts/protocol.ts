import { z } from "zod";
import type { AgentStreamEvent, InputExecutionResponse, PlanExecutionOutcome } from "../../../core/types.js";
import { UI_LIMITS, uiFormResultSchema } from "../../../core/uiForm.js";
import type { AgentSelection } from "../../agents/contracts.js";
import type { ResourceSession } from "../../resources/contracts/resourceSession.js";
import type { DextHistorySession, PlanStatus } from "./history.js";

/** Conversation, execution, plan and patch messages. The global protocol in
 * `src/webviewProtocol.ts` composes this list with the other features, so a
 * conversation change never edits the host's whole message union. */

const conversationSchemaList = [
  z.object({
    type: z.literal("executeInput"),
    mode: z.enum(["agent", "ask", "plan", "code"]),
    source: z.string().min(1),
    planPath: z.string().min(1).max(512).optional()
  }),
  z.object({ type: z.literal("stopExecution"), turnId: z.string().min(1) }),
  z.object({
    type: z.literal("agentInputResponse"),
    sessionId: z.string().min(1), turnId: z.string().min(1), requestId: z.string().min(1),
    // A multi-select question reports every chosen label, and a single-select
    // question can carry one chosen option plus a custom answer, so one answer
    // per question is wrong: the bound matches the checkbox answer shape.
    answers: z.record(z.string().min(1).max(256), z.object({
      answers: z.array(z.string().min(1).max(20000)).min(1).max(UI_LIMITS.options + 1)
    })).nullable()
  }),
  z.object({
    type: z.literal("uiResponse"),
    sessionId: z.string().min(1).max(128), turnId: z.string().min(1).max(128), requestId: z.string().min(1).max(128),
    response: uiFormResultSchema
  }).strict(),
  z.object({ type: z.literal("retryTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("continueTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("forkFromTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("renameTurn"), sessionId: z.string().min(1), turnId: z.string().min(1) }),
  z.object({ type: z.literal("deleteTurn"), turnId: z.string().min(1), sessionId: z.string().min(1).optional() }),
  z.object({ type: z.literal("copyTurn"), turnId: z.string().min(1), sessionId: z.string().min(1) }),
  z.object({ type: z.literal("buildPlan"), planPath: z.string().min(1).max(512) }),
  z.object({ type: z.literal("choosePlan") }),
  z.object({
    type: z.literal("resolvePatch"),
    turnId: z.string().min(1),
    /** Empty means every file the turn proposed, which is the Accept all path. */
    uris: z.array(z.string().min(1)).max(200),
    accept: z.boolean()
  }),
  z.object({ type: z.literal("newConversation") }),
  z.object({ type: z.literal("selectConversation"), sessionId: z.string().min(1), switchId: z.number().int().positive().optional() }),
  z.object({ type: z.literal("outputSessionRefMiss"), sessionId: z.string().min(1), signature: z.string(), switchId: z.number().int().positive().optional(), hostInitiated: z.literal(true).optional() }),
  z.object({ type: z.literal("closeConversation"), sessionId: z.string().min(1) }),
  z.object({
    type: z.literal("moveConversation"),
    sessionId: z.string().min(1),
    beforeSessionId: z.string().min(1).nullable()
  }),
  z.object({
    type: z.literal("pinConversation"),
    sessionId: z.string().min(1),
    pinned: z.boolean()
  }),
  z.object({
    type: z.literal("agentSelection"),
    selection: z.object({
      mode: z.enum(["agent", "ask", "plan", "code"]),
      permission: z.enum(["workspace-write", "full-access"]),
      profileId: z.string(),
      agentPreset: z.string().max(128).optional(),
      model: z.string(),
      reasoningEffort: z.string(),
      speed: z.string(),
      serviceTier: z.string()
    }).strict()
  }),
  z.object({ type: z.literal("harnessPresetAction"), action: z.enum(["create", "copy", "edit", "refresh"]) })
] as const;

/** A tuple, not a widened array: spreading it into the global discriminated
 * union keeps every message's inferred type. */
export const conversationRequestSchemas = conversationSchemaList;

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  turnCount: number;
  pinned: boolean;
  running: boolean;
}

/** Responses owned by the conversation feature. */
export type ConversationWebviewResponse =
  | { type: "outputSession"; session: DextHistorySession; switchId?: number; hostInitiated?: true }
  | { type: "turnRenamed"; sessionId: string; turnId: string; title?: string; displayTitle: string }
  | { type: "outputSessionRef"; sessionId: string; signature: string; switchId?: number; hostInitiated?: true }
  | {
    type: "activeConversation";
    activeId: string;
    selection: AgentSelection;
    planPath?: string;
    planStatus: PlanStatus;
    resource?: ResourceSession;
    switchId?: number;
    hostInitiated?: true;
  }
  | { type: "planContext"; path?: string; status: PlanStatus }
  | { type: "resourceContext"; sessionId: string; resource: ResourceSession; busy?: boolean }
  | {
    type: "conversations";
    sessions: ConversationSummary[];
    activeId: string;
    /** Active conversation-scoped controls, sent with the tab update so a
     * tab switch does not need to resend the full sidebar state. */
    selection?: AgentSelection;
    planPath?: string;
    planStatus?: PlanStatus;
    resource?: ResourceSession;
    switchId?: number;
    hostInitiated?: true;
  }
  /** `reviewPatch` is set when the host is holding an unapplied patch for this
   * turn, which is what puts Accept and Reject on its file changes. */
  | { type: "execution"; sessionId: string; turnId: string; response: InputExecutionResponse; reviewPatch?: boolean }
  | { type: "executionFailed"; sessionId: string; turnId: string; message: string; planOutcome?: PlanExecutionOutcome }
  | {
    type: "patchResolved";
    sessionId: string;
    turnId: string;
    uris: string[];
    status: "applied" | "rejected" | "conflict" | "unchanged";
    message: string;
  }
  | { type: "agentEvent"; sessionId: string; event: AgentStreamEvent }
  | { type: "focusAgentInput"; sessionId: string; turnId: string; requestId: string; kind: "agent" | "ui" }
  | { type: "agentEvents"; sessionId: string; events: AgentStreamEvent[]; switchId?: number }
  | { type: "executing"; sessionId: string; value: boolean; turnId: string; source?: string; mode?: "agent" | "ask" | "plan" | "code"; planPath?: string; executePlan?: boolean; startedAt?: number; switchId?: number; hostInitiated?: true };
