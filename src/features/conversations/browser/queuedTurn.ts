/** A conversation accepts one turn at a time, so the composer holds the next
 * message here and sends it once that conversation reports itself idle. */
export interface QueuedTurn {
  mode: "agent" | "ask" | "plan" | "code";
  source: string;
  planPath?: string;
  resourceSource?: "describe" | "import";
}

export class QueuedTurns {
  private readonly turns = new Map<string, QueuedTurn>();

  queue(sessionId: string, turn: QueuedTurn): void {
    this.turns.set(sessionId, turn);
  }

  peek(sessionId: string): QueuedTurn | undefined {
    return this.turns.get(sessionId);
  }

  /** Hands back the message only when its conversation is ready for it. */
  take(sessionId: string, canSend: boolean): QueuedTurn | undefined {
    const turn = this.turns.get(sessionId);
    if (!turn || !canSend) return undefined;
    this.turns.delete(sessionId);
    return turn;
  }

  delete(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  retain(sessionIds: readonly string[]): void {
    const open = new Set(sessionIds);
    for (const id of [...this.turns.keys()]) {
      if (!open.has(id)) this.turns.delete(id);
    }
  }

  entries(): Array<[string, QueuedTurn]> {
    return [...this.turns.entries()];
  }

  replace(turns: Record<string, QueuedTurn>): void {
    this.turns.clear();
    for (const [id, turn] of Object.entries(turns)) this.turns.set(id, turn);
  }

  toRecord(): Record<string, QueuedTurn> {
    return Object.fromEntries(this.turns);
  }
}
