export interface InputNotificationTarget {
  sessionId: string;
  turnId: string;
  requestId: string;
  kind: "agent" | "ui";
}

/** Track live requests independently of which conversation the Webview shows. */
export class InputNotifications {
  private readonly requests = new Map<string, { target: InputNotificationTarget; waiting: boolean }>();
  private disposed = false;

  constructor(
    private readonly notify: () => PromiseLike<boolean>,
    private readonly open: (target: InputNotificationTarget) => Promise<void>
  ) {}

  private key(target: InputNotificationTarget): string {
    return JSON.stringify([target.sessionId, target.turnId, target.kind, target.requestId]);
  }

  isWaiting(target: InputNotificationTarget): boolean {
    return this.requests.get(this.key(target))?.waiting === true;
  }

  observe(target: InputNotificationTarget, waiting: boolean): void {
    if (this.disposed) return;
    const key = this.key(target);
    const previous = this.requests.get(key);
    if (previous) {
      if (!waiting) previous.waiting = false;
      return;
    }
    const request = { target, waiting };
    this.requests.set(key, request);
    if (!waiting) return;
    // A toast must never block execution or propagate notification errors.
    void (async () => {
      if (await this.notify() && this.requests.get(key) === request && request.waiting) {
        await this.open(target);
      }
    })().catch(() => undefined);
  }

  clearTurn(sessionId: string, turnId: string): void {
    for (const [key, { target }] of this.requests) {
      if (target.sessionId === sessionId && target.turnId === turnId) this.requests.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.requests.clear();
  }
}
