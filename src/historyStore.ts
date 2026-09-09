import { publicInteractionState } from "./uiInteractionPresentation.js";
import type * as vscode from "vscode";
import type { AgentStreamEvent, AgentTodoItem, InputExecutionResponse, PlanExecutionOutcome } from "./core/types.js";
import { normalizeInputReferenceSource } from "./core/fileReference.js";

const HISTORY_KEY = "dext.history";

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
  activePlanPath?: string;
  planStatus?: PlanStatus;
  planProgress?: { path: string; todos: AgentTodoItem[] };
  /** Archived conversations remain available but are hidden from the default history view. */
  archivedAt?: number;
}

function bounded(value: string, maxOutputLength: number): string {
  return value.length > maxOutputLength
    ? `${value.slice(0, maxOutputLength)}\n... output truncated ...`
    : value;
}

function serializeResponse(response: InputExecutionResponse, maxOutputLength: number): string {
  try {
    return bounded(JSON.stringify(response, null, 2), maxOutputLength);
  } catch {
    return "Unable to serialize execution output.";
  }
}

/** Store final interaction states only. Drafts stay in Webview state; secrets
 * are removed defensively even when a provider supplies them in an event. */
function storedProcess(process: readonly AgentStreamEvent[], limit: number): AgentStreamEvent[] {
  const last = new Map<string, number>();
  process.forEach((event, index) => {
    const id = event.uiInteraction ? `ui:${event.uiInteraction.requestId}` : event.userInput ? `agent:${event.userInput.id}` : undefined;
    if (id) last.set(id, index);
  });
  return process.flatMap((event, index) => {
    const next = structuredClone(event); next.text = bounded(event.text, limit);
    if (next.uiInteraction) {
      if (last.get(`ui:${next.uiInteraction.requestId}`) !== index) return [];
      next.uiInteraction = publicInteractionState(next.uiInteraction);
      if (next.uiInteraction.status === "waiting") next.uiInteraction.status = "closed";
      if (JSON.stringify(next.uiInteraction).length > limit) {
        next.text = bounded(JSON.stringify(next.uiInteraction), limit); delete next.uiInteraction;
        next.phase = "message";
      }
    }
    if (next.userInput) {
      if (last.get(`agent:${next.userInput.id}`) !== index) return [];
      if (next.userInput.status === "waiting") next.userInput.status = "dismissed";
      for (const question of next.userInput.questions) if (question.isSecret && next.userInput.answers) delete next.userInput.answers[question.id];
      if (JSON.stringify(next.userInput).length > limit) { next.text = bounded(JSON.stringify(next.userInput), limit); delete next.userInput; next.phase = "message"; }
    }
    return [next];
  });
}

function isSession(value: DextHistoryRecord | DextHistorySession): value is DextHistorySession {
  return Array.isArray((value as DextHistorySession).turns);
}

function normalizeSessions(stored: readonly (DextHistoryRecord | DextHistorySession)[]): DextHistorySession[] {
  return stored.flatMap((item) => isSession(item)
    ? [{ ...item, turns: item.turns.map((turn) => ({ ...turn, input: normalizeInputReferenceSource(turn.input) })) }]
    : [{
        id: `legacy-${item.id}`,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        turns: [{ ...item, input: normalizeInputReferenceSource(item.input) }]
      }]
  );
}

function trimSessions(sessions: readonly DextHistorySession[], maxTurns: number): DextHistorySession[] {
  const next = sessions.map((session) => ({ ...session, turns: [...session.turns] }));
  let turnCount = next.reduce((total, session) => total + session.turns.length, 0);
  while (turnCount > maxTurns && next.length) {
    const index = next.findIndex((session) => session.turns.length > 0);
    if (index === -1) break;
    const first = next[index]!;
    first.turns.shift();
    turnCount -= 1;
    if (!first.turns.length) next.splice(index, 1);
    else first.createdAt = first.turns[0]!.createdAt;
  }
  return next;
}

export class DextHistoryStore {
  private mutation = Promise.resolve();

  /** Limits are read per write rather than captured once, so changing the
   * setting takes effect on the next turn instead of the next window. */
  constructor(
    private readonly state: vscode.Memento,
    private readonly readLimits: () => DextHistoryLimits = () => DEFAULT_HISTORY_LIMITS
  ) {}

  private limits(): DextHistoryLimits {
    const { maxTurns, maxOutputLength } = this.readLimits();
    return {
      maxTurns: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : DEFAULT_HISTORY_LIMITS.maxTurns,
      maxOutputLength: Number.isInteger(maxOutputLength) && maxOutputLength > 0
        ? maxOutputLength
        : DEFAULT_HISTORY_LIMITS.maxOutputLength
    };
  }

  list(includeArchived = false): DextHistorySession[] {
    const stored = this.state.get<(DextHistoryRecord | DextHistorySession)[]>(HISTORY_KEY, []);
    const sessions = normalizeSessions(stored);
    return includeArchived ? sessions : sessions.filter((session) => !session.archivedAt);
  }

  private all(): DextHistorySession[] {
    return this.list(true);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    return this.mutate(async () => {
      const sessions = this.all();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return false;
      if (archived) session.archivedAt ??= Date.now();
      else delete session.archivedAt;
      await this.state.update(HISTORY_KEY, sessions);
      return true;
    });
  }

  async remove(sessionId: string): Promise<void> {
    await this.mutate(async () => {
      const sessions = this.all().filter((session) => session.id !== sessionId);
      await this.state.update(HISTORY_KEY, sessions);
    });
  }

  async renameTurn(sessionId: string, turnId: string, title: string): Promise<boolean> {
    return this.mutate(async () => {
      const sessions = this.all();
      const turn = sessions.find((session) => session.id === sessionId)?.turns.find((item) => item.id === turnId);
      if (!turn) return false;
      const name = title.trim().replace(/[\r\n]+/g, " ").slice(0, 140);
      if (name) turn.title = name;
      else delete turn.title;
      await this.state.update(HISTORY_KEY, sessions);
      return true;
    });
  }

  async updatePlanContext(sessionId: string, activePlanPath: string | undefined, planStatus: PlanStatus): Promise<void> {
    await this.mutate(async () => {
      const sessions = this.all();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      if (activePlanPath) session.activePlanPath = activePlanPath;
      else delete session.activePlanPath;
      session.planStatus = planStatus;
      await this.state.update(HISTORY_KEY, sessions);
    });
  }

  async updatePlanProgress(sessionId: string, path: string, todos: readonly AgentTodoItem[]): Promise<void> {
    await this.mutate(async () => {
      const sessions = this.all();
      let session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        session = { id: sessionId, createdAt: Date.now(), updatedAt: Date.now(), turns: [], activePlanPath: path, planStatus: "running" };
        sessions.push(session);
      }
      session.planProgress = { path, todos: todos.map((item) => ({ ...item })) };
      await this.state.update(HISTORY_KEY, sessions);
    });
  }

  /** Remove a Dext record, without modifying the CLI transcript. Keep an empty
   * conversation if it owns provider bindings so reload can still resume it. */
  async removeTurn(sessionId: string, turnId: string, providerSessions?: Readonly<Record<string, string>>): Promise<boolean> {
    return this.mutate(async () => {
      const sessions = this.all();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return false;
      const index = session.turns.findIndex((turn) => turn.id === turnId);
      if (index === -1) return false;
      if (providerSessions && Object.keys(providerSessions).length) {
        session.providerSessions = { ...session.providerSessions, ...providerSessions };
      }
      session.turns.splice(index, 1);
      if (!session.turns.length && !Object.keys(session.providerSessions ?? {}).length
        && !Object.keys(session.forkProviderSessions ?? {}).length) {
        const sessionIndex = sessions.indexOf(session);
        if (sessionIndex >= 0) sessions.splice(sessionIndex, 1);
      } else if (session.turns.length) {
        session.createdAt = session.turns[0]!.createdAt;
        session.updatedAt = session.turns.at(-1)!.createdAt;
      }
      await this.state.update(HISTORY_KEY, sessions);
      return true;
    });
  }

  // A fork copies turns into a conversation of its own so that continuing it
  // never appends to the conversation it came from.
  async fork(
    turns: readonly DextHistoryRecord[],
    providerSessions?: Readonly<Record<string, string>>
  ): Promise<DextHistorySession> {
    return this.mutate(async () => {
      const createdAt = Date.now();
      const session: DextHistorySession = {
        id: `fork-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt,
        updatedAt: createdAt,
        turns: turns.map((turn, index) => ({
          ...turn,
          id: `${createdAt}-${index}-${Math.random().toString(36).slice(2, 8)}`
        })),
        ...(providerSessions && Object.keys(providerSessions).length
          ? { forkProviderSessions: { ...providerSessions } }
          : {})
      };
      await this.state.update(HISTORY_KEY, trimSessions([...this.all(), session], this.limits().maxTurns));
      return session;
    });
  }

  async setProviderSession(sessionId: string, provider: string, providerSessionId: string): Promise<void> {
    await this.mutate(async () => {
      const sessions = this.all();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      session.providerSessions = { ...(session.providerSessions ?? {}), [provider]: providerSessionId };
      await this.state.update(HISTORY_KEY, sessions);
    });
  }

  async addSuccess(
    input: string,
    process: readonly AgentStreamEvent[],
    response: InputExecutionResponse,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"],
    turnId?: string,
    planExecution?: Pick<DextHistoryRecord, "executePlan" | "planPath" | "planOutcome">
  ): Promise<DextHistoryRecord> {
    const { maxOutputLength } = this.limits();
    return this.add({
      input: bounded(input, maxOutputLength),
      process: storedProcess(process, maxOutputLength),
      output: serializeResponse(response, maxOutputLength),
      ...(mode ? { mode } : {}),
      ...planExecution,
      response
    }, sessionId, turnId);
  }

  async addFailure(
    input: string,
    process: readonly AgentStreamEvent[],
    error: unknown,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"],
    turnId?: string,
    planExecution?: Pick<DextHistoryRecord, "executePlan" | "planPath" | "planOutcome">
  ): Promise<DextHistoryRecord> {
    const message = error instanceof Error ? error.message : String(error);
    const { maxOutputLength } = this.limits();
    return this.add({
      input: bounded(input, maxOutputLength),
      process: storedProcess(process, maxOutputLength),
      output: "",
      ...(mode ? { mode } : {}),
      ...planExecution,
      error: bounded(message, maxOutputLength)
    }, sessionId, turnId);
  }

  private async add(
    record: Omit<DextHistoryRecord, "id" | "createdAt">,
    requestedSessionId?: string,
    requestedTurnId?: string
  ): Promise<DextHistoryRecord> {
    return this.mutate(async () => {
      const createdAt = Date.now();
      const turn: DextHistoryRecord = {
        ...record,
        id: requestedTurnId ?? `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt
      };
      const sessionId = requestedSessionId ?? `single-${turn.id}`;
      const sessions = this.all();
      const existing = sessions.find((session) => session.id === sessionId);
      if (existing) {
        existing.turns.push(turn);
        existing.updatedAt = createdAt;
      } else {
        sessions.push({ id: sessionId, createdAt, updatedAt: createdAt, turns: [turn] });
      }
      await this.state.update(HISTORY_KEY, trimSessions(sessions, this.limits().maxTurns));
      return turn;
    });
  }

  /** Agent work may finish in parallel, but VS Code mementos are whole-value
   * writes. Queue only that short read/modify/write section so one completed
   * conversation cannot overwrite another. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}
