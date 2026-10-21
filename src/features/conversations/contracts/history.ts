import type { ResourceSession } from "../../resources/contracts/resourceSession.js";
import type { AgentStreamEvent, AgentTodoItem, InputExecutionResponse, PlanExecutionOutcome } from "../../../core/types.js";

/** Persisted conversation shape. This contract is safe to import from the
 * browser bundle: it has no VS Code, filesystem or timer dependency. */

export interface DextHistoryLimits {
  /** Turns kept across all conversations. The oldest are dropped first. */
  maxTurns: number;
  /** Characters kept per stored string before it is truncated. */
  maxOutputLength: number;
}

export const DEFAULT_HISTORY_LIMITS: DextHistoryLimits = { maxTurns: 100, maxOutputLength: 200_000 };

export type PlanStatus = "new" | "active" | "running" | "completed" | "failed";

export interface DextHistoryRecord {
  id: string;
  /** Optional display name; the original input remains unchanged. */
  title?: string;
  createdAt: number;
  input: string;
  process: AgentStreamEvent[];
  output: string;
  /** The mode the turn ran in, so that retrying it reproduces the same run.
   * Absent on turns recorded before Dext started tracking it. */
  mode?: "agent" | "ask" | "plan" | "code";
  /** Preserve Plan execution presentation even when a run fails without a response. */
  executePlan?: boolean;
  planPath?: string;
  planOutcome?: PlanExecutionOutcome;
  response?: InputExecutionResponse;
  error?: string;
}

/** The Plan context fields a turn stores with its record. */
export type TurnPlanContext = Pick<DextHistoryRecord, "executePlan" | "planPath" | "planOutcome">;

export interface DextHistorySession {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: DextHistoryRecord[];
  /** Provider-owned session ids, keyed by provider name, used for native
   * resume/fork operations. */
  providerSessions?: Record<string, string>;
  /** Provider session ids from the source conversation. A child consumes the
   * matching entry when its first turn is sent. */
  forkProviderSessions?: Record<string, string>;
  /** Explicit Plan target and lifecycle, kept with the conversation tab. */
  resource?: ResourceSession;
  activePlanPath?: string;
  planStatus?: PlanStatus;
  planProgress?: { path: string; todos: AgentTodoItem[] };
  /** Archived conversations remain available but are hidden from the default history view. */
  archivedAt?: number;
}

/** The persistence capabilities a conversation controller needs. The host store
 * implements it; tests and the coordinator depend only on this shape. */
export interface ConversationHistoryStore {
  list(includeArchived?: boolean): DextHistorySession[];
  setArchived(sessionId: string, archived: boolean): Promise<boolean>;
  remove(sessionId: string): Promise<void>;
  renameTurn(sessionId: string, turnId: string, title: string): Promise<boolean>;
  updateResourceContext(sessionId: string, resource: ResourceSession): Promise<void>;
  updatePlanContext(sessionId: string, activePlanPath: string | undefined, planStatus: PlanStatus): Promise<void>;
  updatePlanProgress(sessionId: string, path: string, todos: readonly AgentTodoItem[]): Promise<void>;
  removeTurn(sessionId: string, turnId: string, providerSessions?: Readonly<Record<string, string>>): Promise<boolean>;
  fork(turns: readonly DextHistoryRecord[], providerSessions?: Readonly<Record<string, string>>): Promise<DextHistorySession>;
  setProviderSession(sessionId: string, provider: string, providerSessionId: string): Promise<void>;
  addSuccess(
    input: string,
    process: readonly AgentStreamEvent[],
    response: InputExecutionResponse,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"],
    turnId?: string,
    planExecution?: TurnPlanContext
  ): Promise<DextHistoryRecord>;
  addFailure(
    input: string,
    process: readonly AgentStreamEvent[],
    error: unknown,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"],
    turnId?: string,
    planExecution?: TurnPlanContext
  ): Promise<DextHistoryRecord>;
}
