import type { ResourceSession } from "../../resources/contracts/resourceSession.js";
import { publicInteractionState } from "../presentation/uiInteractionPresentation.js";
import { normalizeHistoryResponse } from "../domain/historyResponse.js";
import { compactAgentEvents } from "../domain/agentEventLog.js";
import type * as vscode from "vscode";
import type { AgentStreamEvent, AgentTodoItem, InputExecutionResponse } from "../../../shared/contracts/types.js";
import { normalizeInputReferenceSource } from "../../workspace/domain/fileReference.js";
import {
  DEFAULT_HISTORY_LIMITS,
  type ConversationHistoryStore,
  type DextHistoryLimits,
  type DextHistoryRecord,
  type DextHistorySession,
  type PlanStatus,
  type TurnRecordContext
} from "../contracts/history.js";
import { planProjectContextSchema, type PlanProjectContext } from "../../../shared/contracts/planProject.js";

/** Whole-history key from before conversations had keys of their own. Only
 * read to migrate it; new writes never produce it. */
const HISTORY_KEY = "dext.history";
const SESSION_KEY_PREFIX = "dext.history.session:";
const ORDER_KEY = "dext.history.order";

const TRUNCATION_MARKER = "\n... output truncated ...\n";

/** Keep both ends: a command's conclusion matters as much as its start. Every
 * oversized value also lands in `spill`, which becomes the turn's overflow file. */
function bounded(value: string, maxOutputLength: number, spill: string[] = []): string {
  if (value.length <= maxOutputLength) return value;
  spill.push(value);
  const head = Math.ceil(maxOutputLength / 2);
  return `${value.slice(0, head)}${TRUNCATION_MARKER}${value.slice(head - maxOutputLength)}`;
}

/** The input is re-sent by retry/continue, so it is clipped without the marker
 * that would otherwise be pasted into the next prompt. */
function clipped(value: string, maxOutputLength: number, spill: string[]): string {
  if (value.length <= maxOutputLength) return value;
  spill.push(value);
  const head = Math.ceil(maxOutputLength / 2);
  return `${value.slice(0, head)}${value.slice(head - maxOutputLength)}`;
}

function serializeResponse(response: InputExecutionResponse, maxOutputLength: number, spill: string[]): string {
  try {
    return bounded(JSON.stringify(response, null, 2), maxOutputLength, spill);
  } catch {
    return "Unable to serialize execution output.";
  }
}

/** Store final interaction states only. Drafts stay in Webview state; secrets
 * are removed defensively even when a provider supplies them in an event. */
function storedProcess(process: readonly AgentStreamEvent[], limit: number, spill: string[] = []): AgentStreamEvent[] {
  process = compactAgentEvents(process);
  const last = new Map<string, number>();
  process.forEach((event, index) => {
    const id = event.uiInteraction ? `ui:${event.uiInteraction.requestId}` : event.userInput ? `agent:${event.userInput.id}` : undefined;
    if (id) last.set(id, index);
  });
  return process.flatMap((event, index) => {
    const next = structuredClone(event); next.text = bounded(event.text, limit, spill);
    if (next.uiInteraction) {
      if (last.get(`ui:${next.uiInteraction.requestId}`) !== index) return [];
      next.uiInteraction = publicInteractionState(next.uiInteraction);
      if (next.uiInteraction.status === "waiting") next.uiInteraction.status = "closed";
      if (JSON.stringify(next.uiInteraction).length > limit) {
        next.text = bounded(JSON.stringify(next.uiInteraction), limit, spill); delete next.uiInteraction;
        next.phase = "message";
      }
    }
    if (next.userInput) {
      if (last.get(`agent:${next.userInput.id}`) !== index) return [];
      if (next.userInput.status === "waiting") next.userInput.status = "dismissed";
      for (const question of next.userInput.questions) if (question.isSecret && next.userInput.answers) delete next.userInput.answers[question.id];
      if (JSON.stringify(next.userInput).length > limit) { next.text = bounded(JSON.stringify(next.userInput), limit, spill); delete next.userInput; next.phase = "message"; }
    }
    return [next];
  });
}

function isSession(value: DextHistoryRecord | DextHistorySession): value is DextHistorySession {
  return Array.isArray((value as DextHistorySession).turns);
}

function normalizeSessions(stored: readonly (DextHistoryRecord | DextHistorySession)[]): DextHistorySession[] {
  const normalizeTurn = (turn: DextHistoryRecord): DextHistoryRecord => ({
    ...turn, input: normalizeInputReferenceSource(turn.input),
    ...(turn.response ? { response: normalizeHistoryResponse(turn.response, turn.mode) } : {})
  });
  return stored.flatMap((item) => isSession(item)
    ? [{ ...item, turns: item.turns.map(normalizeTurn) }]
    : [{
        id: `legacy-${item.id}`,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        turns: [normalizeTurn(item)]
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

export class DextHistoryStore implements ConversationHistoryStore {
  private mutation = Promise.resolve();

  /** Limits are read per write rather than captured once, so changing the
   * setting takes effect on the next turn instead of the next window. */
  constructor(
    private readonly state: Pick<vscode.Memento, "get" | "update">,
    private readonly readLimits: () => DextHistoryLimits = () => DEFAULT_HISTORY_LIMITS,
    /** Writes the removed text and returns where it went. */
    private readonly writeSpill?: (parts: readonly string[]) => Promise<string | undefined>
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
    const sessions = this.all();
    return includeArchived ? sessions : sessions.filter((session) => !session.archivedAt);
  }

  /** Conversations in creation order. The production state adapter stores
   * these values in separate files, outside VS Code's extension Memento. */
  private all(): DextHistorySession[] {
    const stored = this.order().flatMap((id) => {
      const session = this.state.get<DextHistorySession | undefined>(`${SESSION_KEY_PREFIX}${id}`, undefined);
      return session ? [session] : [];
    });
    const sessions = normalizeSessions(stored);
    const legacy = this.state.get<(DextHistoryRecord | DextHistorySession)[]>(HISTORY_KEY, []);
    if (!Array.isArray(legacy) || !legacy.length) return sessions;
    const known = new Set(sessions.map((session) => session.id));
    return [...normalizeSessions(legacy).filter((session) => !known.has(session.id)), ...sessions];
  }

  /** Persisted ids, tolerated as anything: an older or corrupted value must not
   * take the history down. */
  private order(): string[] {
    const stored = this.state.get<string[]>(ORDER_KEY, []);
    return Array.isArray(stored) ? stored : [];
  }

  /** Writes only touched/trimmed conversations and a changed order. The legacy
   * value path also supports callers that supply an unmigrated state adapter. */
  private async persist(sessions: readonly DextHistorySession[], touched: readonly string[] = []): Promise<void> {
    const turnCounts = new Map(sessions.map((session) => [session.id, session.turns.length]));
    const kept = trimSessions(sessions, this.limits().maxTurns);
    const order = kept.map((session) => session.id);
    const storedOrder = this.order();
    const migrating = this.state.get<unknown>(HISTORY_KEY, undefined) !== undefined;
    for (const id of storedOrder) {
      if (!order.includes(id)) await this.state.update(`${SESSION_KEY_PREFIX}${id}`, undefined);
    }
    for (const session of kept) {
      const stored = this.state.get<DextHistorySession | undefined>(`${SESSION_KEY_PREFIX}${session.id}`, undefined);
      const changed = touched.includes(session.id) || turnCounts.get(session.id) !== session.turns.length;
      if (!changed && (!migrating || stored)) continue;
      await this.state.update(`${SESSION_KEY_PREFIX}${session.id}`, session);
      if (migrating && !storedOrder.includes(session.id)) {
        storedOrder.push(session.id);
        await this.state.update(ORDER_KEY, [...storedOrder]);
      }
    }
    if (migrating || order.length !== storedOrder.length || order.some((id, index) => id !== storedOrder[index])) {
      await this.state.update(ORDER_KEY, order);
    }
    if (migrating) await this.state.update(HISTORY_KEY, undefined);
  }

  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    return this.mutate(async () => {
      const sessions = this.all();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return false;
      if (archived) session.archivedAt ??= Date.now();
      else delete session.archivedAt;
      await this.persist(sessions, [sessionId]);
      return true;
    });
  }

  async remove(sessionId: string): Promise<void> {
    await this.mutate(async () => {
      await this.persist(this.all().filter((session) => session.id !== sessionId));
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
      await this.persist(sessions, [sessionId]);
      return true;
    });
  }

  async updateResourceContext(sessionId: string, resource: ResourceSession): Promise<void> {
    await this.mutate(async () => {
      const sessions = this.all();
      let session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        session = { id: sessionId, createdAt: Date.now(), updatedAt: Date.now(), turns: [] };
        sessions.push(session);
      }
      session.resource = structuredClone(resource);
      await this.persist(sessions, [sessionId]);
    });
  }

  async updatePlanContext(sessionId: string, activePlanPath: string | undefined, planStatus: PlanStatus, projectContext?: PlanProjectContext): Promise<void> {
    await this.mutate(async () => {
      const sessions = this.all();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      if (activePlanPath) session.activePlanPath = activePlanPath;
      else delete session.activePlanPath;
      session.planStatus = planStatus;
      if (projectContext) session.projectContext = planProjectContextSchema.parse(projectContext);
      else if (session.projectContext?.planPath !== activePlanPath) delete session.projectContext;
      await this.persist(sessions, [sessionId]);
    });
  }

  async updatePlanProgress(sessionId: string, path: string, todos: readonly AgentTodoItem[], documentHash?: string): Promise<void> {
    await this.mutate(async () => {
      const sessions = this.all();
      let session = sessions.find((item) => item.id === sessionId);
      if (!session) {
        session = { id: sessionId, createdAt: Date.now(), updatedAt: Date.now(), turns: [], activePlanPath: path, planStatus: "running" };
        sessions.push(session);
      }
      session.planProgress = { path, todos: todos.map((item) => ({ ...item })), ...(documentHash ? { documentHash } : {}) };
      await this.persist(sessions, [sessionId]);
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
      if (!session.resource && !session.turns.length && !Object.keys(session.providerSessions ?? {}).length
        && !Object.keys(session.forkProviderSessions ?? {}).length) {
        const sessionIndex = sessions.indexOf(session);
        if (sessionIndex >= 0) sessions.splice(sessionIndex, 1);
      } else if (session.turns.length) {
        session.createdAt = session.turns[0]!.createdAt;
        session.updatedAt = session.turns.at(-1)!.createdAt;
      }
      await this.persist(sessions, [sessionId]);
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
      await this.persist([...this.all(), session], [session.id]);
      return session;
    });
  }

  async setProviderSession(sessionId: string, provider: string, providerSessionId: string): Promise<void> {
    await this.mutate(async () => {
      const sessions = this.all();
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) return;
      session.providerSessions = { ...(session.providerSessions ?? {}), [provider]: providerSessionId };
      await this.persist(sessions, [sessionId]);
    });
  }

  spillPath(sessionId: string, turnId: string): string | undefined {
    return this.all().find((session) => session.id === sessionId)
      ?.turns.find((turn) => turn.id === turnId)?.spillPath;
  }

  async addSuccess(
    input: string,
    process: readonly AgentStreamEvent[],
    response: InputExecutionResponse,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"],
    turnId?: string,
    turnContext?: TurnRecordContext
  ): Promise<DextHistoryRecord> {
    const { maxOutputLength } = this.limits();
    const spill: string[] = [];
    return this.add({
      input: clipped(input, maxOutputLength, spill),
      process: storedProcess(process, maxOutputLength, spill),
      output: serializeResponse(response, maxOutputLength, spill),
      ...(mode ? { mode } : {}),
      ...turnContext,
      response
    }, sessionId, turnId, spill);
  }

  async addFailure(
    input: string,
    process: readonly AgentStreamEvent[],
    error: unknown,
    sessionId?: string,
    mode?: DextHistoryRecord["mode"],
    turnId?: string,
    turnContext?: TurnRecordContext
  ): Promise<DextHistoryRecord> {
    const message = error instanceof Error ? error.message : String(error);
    const { maxOutputLength } = this.limits();
    const spill: string[] = [];
    return this.add({
      input: clipped(input, maxOutputLength, spill),
      process: storedProcess(process, maxOutputLength, spill),
      output: "",
      ...(mode ? { mode } : {}),
      ...turnContext,
      error: bounded(message, maxOutputLength, spill)
    }, sessionId, turnId, spill);
  }

  private async add(
    record: Omit<DextHistoryRecord, "id" | "createdAt">,
    requestedSessionId?: string,
    requestedTurnId?: string,
    spill: readonly string[] = []
  ): Promise<DextHistoryRecord> {
    return this.mutate(async () => {
      const createdAt = Date.now();
      const turn: DextHistoryRecord = {
        ...record,
        id: requestedTurnId ?? `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt
      };
      // A failed overflow write must never cost the turn: the clipped text stays.
      const spillPath = spill.length ? await this.writeSpill?.(spill) : undefined;
      if (spillPath) turn.spillPath = spillPath;
      const sessionId = requestedSessionId ?? `single-${turn.id}`;
      const sessions = this.all();
      const existing = sessions.find((session) => session.id === sessionId);
      if (existing) {
        existing.turns.push(turn);
        existing.updatedAt = createdAt;
      } else {
        sessions.push({ id: sessionId, createdAt, updatedAt: createdAt, turns: [turn] });
      }
      await this.persist(sessions, [sessionId]);
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
