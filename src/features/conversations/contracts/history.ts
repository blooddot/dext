import type { ResourceSession } from "../../resources/contracts/resourceSession.js";
import type { AgentStreamEvent, AgentTodoItem, InputExecutionResponse, PlanExecutionOutcome } from "../../../shared/contracts/types.js";

/** Persisted conversation shape. This contract is safe to import from the
 * browser bundle: it has no VS Code, filesystem or timer dependency. */

export interface DextHistoryLimits {
  /** Turns kept across all conversations. The oldest are dropped first.
   * `0` keeps every turn: nothing is trimmed. */
  maxTurns: number;
  /** Characters kept per stored string before it is truncated. */
  maxOutputLength: number;
}

/** 64k mirrors the CLI harnesses (dsh 64 KB, Pi 50 KB): a turn that needs more
 * is spilled to a file, not carried through the extension host. `maxTurns: 0`
 * matches Codex and Claude: history is kept until the user deletes it. */
export const DEFAULT_HISTORY_LIMITS: DextHistoryLimits = { maxTurns: 0, maxOutputLength: 64_000 };

export type PlanStatus = "new" | "active" | "running" | "completed" | "failed";

/** A `/command` invocation captured with the turn so retry and audit can show
 * what template ran without re-resolving it against a changed skill set. */
export interface TurnCommandSnapshot {
  id: string;
  skillId: string;
}

export type ResourceSourceKind = "describe" | "import";

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
  /** File holding the text this turn's truncation removed, opened on demand. */
  spillPath?: string;
  /** Skills that were enabled for this turn. */
  skills?: string[];
  /** The command this turn invoked, if any. */
  command?: TurnCommandSnapshot;
  /** Which creation mode produced a resource draft. */
  resourceSource?: ResourceSourceKind;
}

/** The Plan context fields a turn stores with its record. */
export type TurnPlanContext = Pick<DextHistoryRecord, "executePlan" | "planPath" | "planOutcome">;

/** Everything the coordinator records beside a turn's result. */
export type TurnRecordContext = TurnPlanContext
  & Pick<DextHistoryRecord, "skills" | "command" | "resourceSource">;

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

/** One conversation's metadata. Listing, tabs and titles read only this, so
 * rendering History never parses a conversation body. */
export interface DextHistorySummary {
  id: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  /** The first turn's input, kept so a conversation has a title without
   * reading its body. */
  firstInput?: string;
  archivedAt?: number;
  resource?: ResourceSession;
  activePlanPath?: string;
  planStatus?: PlanStatus;
  planProgress?: { path: string; todos: AgentTodoItem[] };
  providerSessions?: Record<string, string>;
  forkProviderSessions?: Record<string, string>;
  /** Where each turn's truncated text was spilled, keyed by turn id. Kept in
   * the index so pruning overflow never has to read a body. */
  spills?: Record<string, string>;
}

/** The two-tier persistence the store sits on: an index of summaries that is
 * loaded whole, and one body per conversation that is read on demand. */
export interface HistoryBackend {
  /** Every conversation's metadata, in creation order. Synchronous: the index
   * is the only thing an activation reads. */
  summaries(): DextHistorySummary[];
  read(sessionId: string): Promise<DextHistorySession | undefined>;
  /** Appends one turn to a conversation, creating it when absent. */
  appendTurn(sessionId: string, turn: DextHistoryRecord): Promise<void>;
  /** Replaces a conversation's turns and its summary. */
  writeTurns(session: DextHistorySession): Promise<void>;
  /** Rewrites one conversation's metadata and leaves its body alone. */
  writeMeta(summary: DextHistorySummary): Promise<void>;
  remove(sessionId: string): Promise<void>;
  setOrder(order: readonly string[]): Promise<void>;
  /** Re-reads what another window may have committed since this one loaded. */
  refresh(): Promise<void>;
  /** Writes removed text and returns where it went. */
  writeSpill?(parts: readonly string[]): Promise<string | undefined>;
}

/** An index entry and a conversation body are two views of one conversation;
 * these two helpers are the only converters, so the index cannot drift into a
 * different shape from the body. */
export function historySummaryOf(session: DextHistorySession): DextHistorySummary {
  const spills: Record<string, string> = {};
  for (const turn of session.turns) if (turn.spillPath) spills[turn.id] = turn.spillPath;
  return {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turns.length,
    ...(session.turns[0] ? { firstInput: session.turns[0].input } : {}),
    ...(session.archivedAt !== undefined ? { archivedAt: session.archivedAt } : {}),
    ...(session.resource ? { resource: session.resource } : {}),
    ...(session.activePlanPath !== undefined ? { activePlanPath: session.activePlanPath } : {}),
    ...(session.planStatus !== undefined ? { planStatus: session.planStatus } : {}),
    ...(session.planProgress ? { planProgress: session.planProgress } : {}),
    ...(session.providerSessions ? { providerSessions: session.providerSessions } : {}),
    ...(session.forkProviderSessions ? { forkProviderSessions: session.forkProviderSessions } : {}),
    ...(Object.keys(spills).length ? { spills } : {})
  };
}

export function historySessionOf(summary: DextHistorySummary, turns: readonly DextHistoryRecord[]): DextHistorySession {
  return {
    id: summary.id,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    turns: [...turns],
    ...(summary.resource ? { resource: summary.resource } : {}),
    ...(summary.activePlanPath !== undefined ? { activePlanPath: summary.activePlanPath } : {}),
    ...(summary.planStatus !== undefined ? { planStatus: summary.planStatus } : {}),
    ...(summary.planProgress ? { planProgress: summary.planProgress } : {}),
    ...(summary.providerSessions ? { providerSessions: summary.providerSessions } : {}),
    ...(summary.forkProviderSessions ? { forkProviderSessions: summary.forkProviderSessions } : {}),
    ...(summary.archivedAt !== undefined ? { archivedAt: summary.archivedAt } : {})
  };
}

/** Older history kept flat one-turn records; each becomes a conversation. */
export function legacyHistorySession(item: DextHistoryRecord | DextHistorySession): DextHistorySession {
  return "turns" in item
    ? item
    : { id: `legacy-${item.id}`, createdAt: item.createdAt, updatedAt: item.createdAt, turns: [item] };
}

/** The persistence capabilities a conversation controller needs. The host store
 * implements it; tests and the coordinator depend only on this shape. */
export interface ConversationHistoryStore {
  summaries(includeArchived?: boolean): DextHistorySummary[];
  session(sessionId: string): Promise<DextHistorySession | undefined>;
  sessions(includeArchived?: boolean): Promise<DextHistorySession[]>;
  setArchived(sessionId: string, archived: boolean): Promise<boolean>;
  remove(sessionId: string): Promise<void>;
  renameTurn(sessionId: string, turnId: string, title: string): Promise<boolean>;
  updateResourceContext(sessionId: string, resource: ResourceSession): Promise<void>;
  updatePlanContext(sessionId: string, activePlanPath: string | undefined, planStatus: PlanStatus): Promise<void>;
  updatePlanProgress(sessionId: string, path: string, todos: readonly AgentTodoItem[]): Promise<void>;
  removeTurn(sessionId: string, turnId: string, providerSessions?: Readonly<Record<string, string>>): Promise<boolean>;
  fork(turns: readonly DextHistoryRecord[], providerSessions?: Readonly<Record<string, string>>): Promise<DextHistorySession>;
  setProviderSession(sessionId: string, provider: string, providerSessionId: string): Promise<void>;
  /** Where this turn's truncated text was spilled, if it was. */
  spillPath(sessionId: string, turnId: string): string | undefined;
  addSuccess(
    input: string,
    process: readonly AgentStreamEvent[],
    response: InputExecutionResponse,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"],
    turnId?: string,
    turnContext?: TurnRecordContext
  ): Promise<DextHistoryRecord>;
  addFailure(
    input: string,
    process: readonly AgentStreamEvent[],
    error: unknown,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"],
    turnId?: string,
    turnContext?: TurnRecordContext
  ): Promise<DextHistoryRecord>;
}
