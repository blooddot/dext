import {
  historySessionOf, historySummaryOf, legacyHistorySession,
  type DextHistoryRecord, type DextHistorySession, type DextHistorySummary, type HistoryBackend
} from "../src/features/conversations/contracts/history.js";

export interface MemoryHistoryBackendOptions {
  /** The obsolete single-blob history an older workspace still holds. */
  legacy?: readonly (DextHistoryRecord | DextHistorySession)[];
  /** Conversations to start with, as if a previous window had written them. */
  sessions?: readonly DextHistorySession[];
  /** Make every write slow enough for two callers to interleave. */
  delayed?: boolean;
}

/** The disk backend without the disk: an index of summaries plus one body per
 * conversation, so a test proves laziness by touching only the index. */
export class MemoryHistoryBackend implements HistoryBackend {
  private order: string[] = [];
  private readonly meta = new Map<string, DextHistorySummary>();
  private readonly bodies = new Map<string, DextHistoryRecord[]>();
  /** Body writes, so a test can assert one turn touches one conversation. */
  readonly written: string[] = [];
  /** Every part list handed to the spill writer. */
  readonly spilled: string[][] = [];

  constructor(private readonly options: MemoryHistoryBackendOptions = {}) {
    for (const item of options.legacy ?? []) this.put(legacyHistorySession(structuredClone(item)));
    for (const session of options.sessions ?? []) this.put(structuredClone(session));
  }

  /** Stores conversations the way a previous window would have. */
  seed(sessions: readonly DextHistorySession[]): void {
    for (const session of sessions) this.put(structuredClone(session));
  }

  summaries(): DextHistorySummary[] {
    return this.order.flatMap((id) => {
      const summary = this.meta.get(id);
      return summary ? [structuredClone(summary)] : [];
    });
  }

  async read(sessionId: string): Promise<DextHistorySession | undefined> {
    await this.delay();
    const summary = this.meta.get(sessionId);
    return summary ? historySessionOf(structuredClone(summary), this.bodies.get(sessionId) ?? []) : undefined;
  }

  async appendTurn(sessionId: string, turn: DextHistoryRecord): Promise<void> {
    await this.delay();
    const turns = [...(this.bodies.get(sessionId) ?? []), structuredClone(turn)];
    const summary = this.meta.get(sessionId) ?? { id: sessionId, createdAt: turn.createdAt, updatedAt: turn.createdAt, turnCount: 0 };
    this.written.push(sessionId);
    this.bodies.set(sessionId, turns);
    this.index({ ...summary, updatedAt: turn.createdAt, turnCount: turns.length, firstInput: turns[0]!.input,
      ...(turn.spillPath ? { spills: { ...summary.spills, [turn.id]: turn.spillPath } } : {}) });
  }

  async writeTurns(session: DextHistorySession): Promise<void> {
    await this.delay();
    this.written.push(session.id);
    this.bodies.set(session.id, structuredClone(session.turns));
    this.index(historySummaryOf(structuredClone(session)));
  }

  async writeMeta(summary: DextHistorySummary): Promise<void> {
    await this.delay();
    this.index(structuredClone(summary));
  }

  async remove(sessionId: string): Promise<void> {
    await this.delay();
    this.written.push(sessionId);
    this.bodies.delete(sessionId);
    this.meta.delete(sessionId);
    this.order = this.order.filter((id) => id !== sessionId);
  }

  async setOrder(order: readonly string[]): Promise<void> {
    await this.delay();
    this.order = order.filter((id) => this.meta.has(id));
  }

  /** Nothing to re-read: every test window shares this instance. */
  async refresh(): Promise<void> {}

  async writeSpill(parts: readonly string[]): Promise<string | undefined> {
    this.spilled.push([...parts]);
    return "/tmp/overflow.txt";
  }

  private put(session: DextHistorySession): void {
    this.bodies.set(session.id, session.turns);
    this.index(historySummaryOf(session));
  }

  private index(summary: DextHistorySummary): void {
    this.meta.set(summary.id, summary);
    if (!this.order.includes(summary.id)) this.order.push(summary.id);
  }

  private async delay(): Promise<void> {
    if (this.options.delayed) await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
