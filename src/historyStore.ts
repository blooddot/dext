import type * as vscode from "vscode";
import type { AgentStreamEvent, InputExecutionResponse } from "./core/types.js";
import { normalizeInputReferenceSource } from "./core/fileReference.js";

const HISTORY_KEY = "dext.history";
const MAX_TURNS = 100;
const MAX_OUTPUT_LENGTH = 200_000;

export interface DextHistoryRecord {
  id: string;
  createdAt: number;
  input: string;
  process: AgentStreamEvent[];
  output: string;
  response?: InputExecutionResponse;
  error?: string;
}

export interface DextHistorySession {
  id: string;
  createdAt: number;
  updatedAt: number;
  turns: DextHistoryRecord[];
}

function bounded(value: string): string {
  return value.length > MAX_OUTPUT_LENGTH
    ? `${value.slice(0, MAX_OUTPUT_LENGTH)}\n... output truncated ...`
    : value;
}

function serializeResponse(response: InputExecutionResponse): string {
  try {
    return bounded(JSON.stringify(response, null, 2));
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

function trimSessions(sessions: readonly DextHistorySession[]): DextHistorySession[] {
  const next = sessions.map((session) => ({ ...session, turns: [...session.turns] }));
  let turnCount = next.reduce((total, session) => total + session.turns.length, 0);
  while (turnCount > MAX_TURNS && next.length) {
    const first = next[0]!;
    first.turns.shift();
    turnCount -= 1;
    if (!first.turns.length) next.shift();
    else first.createdAt = first.turns[0]!.createdAt;
  }
  return next;
}

export class DextHistoryStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): DextHistorySession[] {
    const stored = this.state.get<(DextHistoryRecord | DextHistorySession)[]>(HISTORY_KEY, []);
    return normalizeSessions(stored);
  }

  async addSuccess(
    input: string,
    process: readonly AgentStreamEvent[],
    response: InputExecutionResponse,
    sessionId?: string
  ): Promise<DextHistoryRecord> {
    return this.add({
      input: bounded(input),
      process: process.map((event) => ({ ...event, text: bounded(event.text) })),
      output: serializeResponse(response),
      response
    }, sessionId);
  }

  async addFailure(
    input: string,
    process: readonly AgentStreamEvent[],
    error: unknown,
    sessionId?: string
  ): Promise<DextHistoryRecord> {
    const message = error instanceof Error ? error.message : String(error);
    return this.add({
      input: bounded(input),
      process: process.map((event) => ({ ...event, text: bounded(event.text) })),
      output: "",
      error: bounded(message)
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
    await this.state.update(HISTORY_KEY, trimSessions(sessions));
    return turn;
  }
}
