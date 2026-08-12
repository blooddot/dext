export class ReadyMessageQueue<T> {
  private ready = false;
  private readonly pending: T[] = [];

  markNotReady(): void {
    this.ready = false;
  }

  markReady(): T[] {
    this.ready = true;
    return this.pending.splice(0);
  }

  enqueue(message: T): boolean {
    if (this.ready) return false;
    this.pending.push(message);
    return true;
  }

  get isReady(): boolean {
    return this.ready;
  }

  clear(): void {
    this.pending.splice(0);
    this.ready = false;
  }
}
