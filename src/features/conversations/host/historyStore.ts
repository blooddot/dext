import type { ResourceSession } from "../../resources/contracts/resourceSession.js";
import { publicInteractionState } from "../presentation/uiInteractionPresentation.js";
import { normalizeHistoryResponse } from "../domain/historyResponse.js";
import { compactAgentEvents } from "../domain/agentEventLog.js";
import type { AgentStreamEvent, AgentTodoItem, InputExecutionResponse } from "../../../shared/contracts/types.js";
import { normalizeInputReferenceSource } from "../../workspace/domain/fileReference.js";
import {
  DEFAULT_HISTORY_LIMITS,
  type ConversationHistoryStore,
  type DextHistoryLimits,
  type DextHistoryRecord,
  type DextHistorySession,
  type DextHistorySummary,
  type HistoryBackend,
  type PlanStatus,
  type TurnRecordContext
} from "../contracts/history.js";
import { truncateMiddle } from "../domain/truncation.js";

/** Keep both ends: a command's conclusion matters as much as its start. Every
 * oversized value also lands in `spill`, which becomes the turn's overflow file. */
function bounded(value: string, maxOutputLength: number, spill: string[] = []): string {
  if (value.length <= maxOutputLength) return value;
  spill.push(value);
  return truncateMiddle(value, maxOutputLength);
}

/** The input is re-sent by retry/continue, so it is clipped without the marker
 * that would otherwise be pasted into the next prompt. */
function clipped(value: string, maxOutputLength: number, spill: string[]): string {
  if (value.length <= maxOutputLength) return value;
  spill.push(value);
  return truncateMiddle(value, maxOutputLength, "");
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

/** Turns saved before reference storage changed still point at inline markers. */
function normalizeSession(session: DextHistorySession): DextHistorySession {
  return {
    ...session,
    turns: session.turns.map((turn) => ({
      ...turn,
      input: normalizeInputReferenceSource(turn.input),
      ...(turn.response ? { response: normalizeHistoryResponse(turn.response, turn.mode) } : {})
    }))
  };
}

export class DextHistoryStore implements ConversationHistoryStore {
  private mutation = Promise.resolve();

  /** Limits are read per write rather than captured once, so changing the
   * setting takes effect on the next turn instead of the next window. */
  constructor(
    private readonly backend: HistoryBackend,
    private readonly readLimits: () => DextHistoryLimits = () => DEFAULT_HISTORY_LIMITS
  ) {}

  private limits(): DextHistoryLimits {
    const { maxTurns, maxOutputLength } = this.readLimits();
    return {
      // 0 is the default and means "keep every turn"; only a negative or
      // non-integer value falls back.
      maxTurns: Number.isInteger(maxTurns) && maxTurns >= 0 ? maxTurns : DEFAULT_HISTORY_LIMITS.maxTurns,
      maxOutputLength: Number.isInteger(maxOutputLength) && maxOutputLength > 0
        ? maxOutputLength
        : DEFAULT_HISTORY_LIMITS.maxOutputLength
    };
  }

  /** Metadata only: History, the tab strip and titles never wait for a body. */
  summaries(includeArchived = false): DextHistorySummary[] {
    const all = this.backend.summaries();
    return includeArchived ? all : all.filter((summary) => !summary.archivedAt);
  }

  async session(sessionId: string): Promise<DextHistorySession | undefined> {
    const session = await this.backend.read(sessionId);
    return session ? normalizeSession(session) : undefined;
  }

  async sessions(includeArchived = false): Promise<DextHistorySession[]> {
    const sessions: DextHistorySession[] = [];
    for (const summary of this.summaries(includeArchived)) {
      const session = await this.backend.read(summary.id);
      if (session) sessions.push(normalizeSession(session));
    }
    return sessions;
  }

  private summary(sessionId: string): DextHistorySummary | undefined {
    const summary = this.backend.summaries().find((item) => item.id === sessionId);
    return summary ? structuredClone(summary) : undefined;
  }

  async setArchived(sessionId: string, archived: boolean): Promise<boolean> {
    return this.mutate(async () => {
      const summary = this.summary(sessionId);
      if (!summary) return false;
      if (archived) summary.archivedAt ??= Date.now();
      else delete summary.archivedAt;
      await this.backend.writeMeta(summary);
      return true;
    });
  }

  async remove(sessionId: string): Promise<void> {
    await this.mutate(() => this.backend.remove(sessionId));
  }

  async renameTurn(sessionId: string, turnId: string, title: string): Promise<boolean> {
    return this.mutate(async () => {
      const session = await this.backend.read(sessionId);
      const turn = session?.turns.find((item) => item.id === turnId);
      if (!session || !turn) return false;
      const name = title.trim().replace(/[\r\n]+/g, " ").slice(0, 140);
      if (name) turn.title = name;
      else delete turn.title;
      await this.backend.writeTurns(session);
      return true;
    });
  }

  async updateResourceContext(sessionId: string, resource: ResourceSession): Promise<void> {
    await this.mutate(async () => {
      const summary = this.summary(sessionId) ?? { id: sessionId, createdAt: Date.now(), updatedAt: Date.now(), turnCount: 0 };
      summary.resource = structuredClone(resource);
      await this.backend.writeMeta(summary);
    });
  }

  async updatePlanContext(sessionId: string, activePlanPath: string | undefined, planStatus: PlanStatus): Promise<void> {
    await this.mutate(async () => {
      const summary = this.summary(sessionId);
      if (!summary) return;
      if (activePlanPath) summary.activePlanPath = activePlanPath;
      else delete summary.activePlanPath;
      summary.planStatus = planStatus;
      await this.backend.writeMeta(summary);
    });
  }

  async updatePlanProgress(sessionId: string, path: string, todos: readonly AgentTodoItem[]): Promise<void> {
    await this.mutate(async () => {
      const summary = this.summary(sessionId)
        ?? { id: sessionId, createdAt: Date.now(), updatedAt: Date.now(), turnCount: 0, activePlanPath: path, planStatus: "running" as const };
      summary.planProgress = { path, todos: todos.map((item) => ({ ...item })) };
      await this.backend.writeMeta(summary);
    });
  }

  /** Remove a Dext record, without modifying the CLI transcript. Keep an empty
   * conversation if it owns provider bindings so reload can still resume it. */
  async removeTurn(sessionId: string, turnId: string, providerSessions?: Readonly<Record<string, string>>): Promise<boolean> {
    return this.mutate(async () => {
      const session = await this.backend.read(sessionId);
      if (!session) return false;
      const index = session.turns.findIndex((turn) => turn.id === turnId);
      if (index === -1) return false;
      if (providerSessions && Object.keys(providerSessions).length) {
        session.providerSessions = { ...session.providerSessions, ...providerSessions };
      }
      session.turns.splice(index, 1);
      if (!session.resource && !session.turns.length && !Object.keys(session.providerSessions ?? {}).length
        && !Object.keys(session.forkProviderSessions ?? {}).length) {
        await this.backend.remove(sessionId);
      } else {
        if (session.turns.length) {
          session.createdAt = session.turns[0]!.createdAt;
          session.updatedAt = session.turns.at(-1)!.createdAt;
        }
        await this.backend.writeTurns(session);
      }
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
      await this.backend.writeTurns(session);
      return session;
    });
  }

  async setProviderSession(sessionId: string, provider: string, providerSessionId: string): Promise<void> {
    await this.mutate(async () => {
      const summary = this.summary(sessionId);
      if (!summary) return;
      summary.providerSessions = { ...(summary.providerSessions ?? {}), [provider]: providerSessionId };
      await this.backend.writeMeta(summary);
    });
  }

  spillPath(sessionId: string, turnId: string): string | undefined {
    return this.backend.summaries().find((summary) => summary.id === sessionId)?.spills?.[turnId];
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
      const spillPath = spill.length ? await this.backend.writeSpill?.(spill) : undefined;
      if (spillPath) turn.spillPath = spillPath;
      await this.backend.appendTurn(requestedSessionId ?? `single-${turn.id}`, turn);
      await this.trim();
      return turn;
    });
  }

  /** `maxTurns: 0` keeps every turn. A positive limit drops the oldest turns
   * across all conversations, dropping a conversation once it runs out. */
  private async trim(): Promise<void> {
    const maxTurns = this.limits().maxTurns;
    if (maxTurns <= 0) return;
    const summaries = this.backend.summaries();
    let total = summaries.reduce((count, summary) => count + summary.turnCount, 0);
    for (const summary of summaries) {
      if (total <= maxTurns) return;
      if (!summary.turnCount) continue;
      const session = await this.backend.read(summary.id);
      if (!session) {
        await this.backend.remove(summary.id);
        continue;
      }
      const drop = Math.min(session.turns.length, total - maxTurns);
      const turns = session.turns.slice(drop);
      total -= drop;
      if (!turns.length) await this.backend.remove(summary.id);
      else await this.backend.writeTurns({ ...session, turns, createdAt: turns[0]!.createdAt });
    }
  }

  /** Agent work may finish in parallel, but the index is a whole-file write.
   * Queue only that short read/modify/write section so one completed
   * conversation cannot overwrite another. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      // Another window's committed metadata must be seen before this one
      // rewrites the index over it.
      await this.backend.refresh();
      return operation();
    };
    const result = this.mutation.then(run, run);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}
