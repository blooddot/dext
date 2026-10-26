import type { AgentProfile } from "../../agents/contracts/agent.js";
import type { ResourceDocument, ResourceSession } from "../../resources/contracts/resourceSession.js";
import type { DextReplayEntry } from "../../../shared/contracts/replay.js";
import type {
  AgentInputAnswers,
  AgentInputRequest,
  AgentStreamEvent,
  AgentTodoItem,
  ExecutionMetadata,
  InputExecutionResponse,
  PlanExecutionOutcome,
  UiInteraction
} from "../../../shared/contracts/types.js";
import type { DextHistoryRecord, DextHistorySession } from "./history.js";
import type { SkillCommandResolution } from "../../workflow/contracts/skill.js";

/** A conversation turn mode. */
export type ConversationMode = "agent" | "ask" | "plan" | "code";

/** The identity a running turn is pinned to. A tab switch, a late provider
 * event or a stale webview callback compares against this snapshot, never
 * against the currently visible conversation. */
export interface ExecutionSnapshot {
  sessionId: string;
  turnId: string;
  mode: ConversationMode;
  source: string;
  startedAt: number;
  planPath?: string;
  executePlan?: boolean;
}

export interface ActiveExecution extends ExecutionSnapshot {
  controller: AbortController;
  /** Buffered events, replayed when the user returns to this conversation. */
  events: AgentStreamEvent[];
}

/** The application capabilities one turn needs. Deliberately not the whole
 * application: a conversation module cannot reach settings, resources or
 * provider discovery through it. */
export interface TurnExecutionHost {
  profiles: () => readonly AgentProfile[];
  executeConversation: (
    mode: "agent" | "ask" | "plan",
    source: string,
    metadata: Readonly<ExecutionMetadata>
  ) => Promise<InputExecutionResponse>;
  executeInput: (
    source: string,
    metadata: Readonly<ExecutionMetadata>,
    run: { resume?: readonly DextReplayEntry[]; onCallLog?: (entries: readonly DextReplayEntry[]) => void }
  ) => Promise<InputExecutionResponse>;
  draftResource: (
    resource: ResourceSession,
    source: string,
    metadata: Readonly<ExecutionMetadata>
  ) => Promise<{ draft: ResourceDocument; response: InputExecutionResponse }>;
  /** Resolves an installed `/command` against the turn's selected skills.
   * Absent in hostless tests, where slash text stays ordinary input. */
  resolveSkillCommand?: (
    id: string,
    selectedSkillIds: readonly string[],
    args: string
  ) => SkillCommandResolution;
}

/** Interaction ownership for the turn: the coordinator passes the session and
 * turn id, and the broker decides whether a response still matches. */
export interface TurnInteractionPort {
  uiInteraction: (sessionId: string, turnId: string, events: AgentStreamEvent[]) => UiInteraction;
  requestAgentInput: (
    sessionId: string,
    turnId: string,
    request: AgentInputRequest,
    signal: AbortSignal
  ) => Promise<AgentInputAnswers | null>;
}

/** Session ownership. The conversation controller is the single writer of the
 * in-memory session map; the coordinator reports what happened and never
 * mutates tabs, layout or the active conversation. */
export interface ConversationSessionPort {
  session: (sessionId: string) => DextHistorySession | undefined;
  recordTurn: (sessionId: string, turn: DextHistoryRecord) => void;
  saveProviderSessions: (session: DextHistorySession) => Promise<void>;
  savePlanProgress: (sessionId: string, path: string, todos: readonly AgentTodoItem[]) => Promise<void>;
  savePlanContext: (sessionId: string, path: string | undefined, status: NonNullable<DextHistorySession["planStatus"]>) => Promise<void>;
  saveResource: (session: DextHistorySession) => Promise<void>;
  postConversationState: () => Promise<void>;
  postPlanContext: () => Promise<void>;
}

/** Everything the coordinator publishes, without owning the IPC channel. */
export interface TurnNotifier {
  started: (snapshot: ExecutionSnapshot) => Promise<void>;
  executed: (sessionId: string, turnId: string, response: InputExecutionResponse, reviewPatch: boolean) => Promise<void>;
  failed: (sessionId: string, turnId: string, message: string, planOutcome?: PlanExecutionOutcome) => Promise<void>;
  finished: (sessionId: string, turnId: string) => Promise<void>;
}

/** Pending patch ownership belongs to the patch review controller. */
export interface TurnPatchPort {
  /** Returns true when the turn left something a reader must review. */
  hold: (turnId: string, response: InputExecutionResponse) => boolean;
}
