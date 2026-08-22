import type * as vscode from "vscode";
import type { AgentStreamEvent, InputExecutionResponse } from "./core/types.js";
import { normalizeInputReferenceSource } from "./core/fileReference.js";

const HISTORY_KEY = "dext.history";

export interface DextHistoryLimits {
  /** Turns kept across all conversations. The oldest are dropped first. */
  maxTurns: number;
  /** Characters kept per stored string before it is truncated. */
  maxOutputLength: number;
}

export const DEFAULT_HISTORY_LIMITS: DextHistoryLimits = { maxTurns: 100, maxOutputLength: 200_000 };

export interface DextHistoryRecord {
  id: string;
  createdAt: number;
  input: string;
  process: AgentStreamEvent[];
  output: string;
  /** The mode the turn ran in, so that retrying it reproduces the same run.
   * Absent on turns recorded before Dext started tracking it. */
  mode?: "agent" | "ask" | "plan" | "code";
  response?: InputExecutionResponse;
  error?: string;
}

export interface DextHistorySession {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: DextHistoryRecord[];
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
    const first = next[0]!;
    first.turns.shift();
    turnCount -= 1;
    if (!first.turns.length) next.shift();
    else first.createdAt = first.turns[0]!.createdAt;
  }
  return next;
}

export class DextHistoryStore {
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

  list(): DextHistorySession[] {
    const stored = this.state.get<(DextHistoryRecord | DextHistorySession)[]>(HISTORY_KEY, []);
    return normalizeSessions(stored);
  }

  async remove(sessionId: string): Promise<void> {
    const sessions = this.list().filter((session) => session.id !== sessionId);
    await this.state.update(HISTORY_KEY, sessions);
  }

  // A fork copies turns into a conversation of its own so that continuing it
  // never appends to the conversation it came from.
  async fork(turns: readonly DextHistoryRecord[]): Promise<DextHistorySession> {
    const createdAt = Date.now();
    const session: DextHistorySession = {
      id: `fork-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt,
      updatedAt: createdAt,
      turns: turns.map((turn, index) => ({
        ...turn,
        id: `${createdAt}-${index}-${Math.random().toString(36).slice(2, 8)}`
      }))
    };
    await this.state.update(HISTORY_KEY, trimSessions([...this.list(), session], this.limits().maxTurns));
    return session;
  }

  async addSuccess(
    input: string,
    process: readonly AgentStreamEvent[],
    response: InputExecutionResponse,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"]
  ): Promise<DextHistoryRecord> {
    const { maxOutputLength } = this.limits();
    return this.add({
      input: bounded(input, maxOutputLength),
      process: process.map((event) => ({ ...event, text: bounded(event.text, maxOutputLength) })),
      output: serializeResponse(response, maxOutputLength),
      ...(mode ? { mode } : {}),
      response
    }, sessionId);
  }

  async addFailure(
    input: string,
    process: readonly AgentStreamEvent[],
    error: unknown,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"]
  ): Promise<DextHistoryRecord> {
    const message = error instanceof Error ? error.message : String(error);
    const { maxOutputLength } = this.limits();
    return this.add({
      input: bounded(input, maxOutputLength),
      process: process.map((event) => ({ ...event, text: bounded(event.text, maxOutputLength) })),
      output: "",
      ...(mode ? { mode } : {}),
      error: bounded(message, maxOutputLength)
    }, sessionId);
  }

  private async add(
    record: Omit<DextHistoryRecord, "id" | "createdAt">,
    requestedSessionId?: string
  ): Promise<DextHistoryRecord> {
    const createdAt = Date.now();
    const turn: DextHistoryRecord = {
      ...record,
      id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt
    };
    const sessionId = requestedSessionId ?? `single-${turn.id}`;
    const sessions = this.list();
    const existing = sessions.find((session) => session.id === sessionId);
    if (existing) {
      existing.turns.push(turn);
      existing.updatedAt = createdAt;
    } else {
      sessions.push({ id: sessionId, createdAt, updatedAt: createdAt, turns: [turn] });
    }
    await this.state.update(HISTORY_KEY, trimSessions(sessions, this.limits().maxTurns));
    return turn;
  }
}
