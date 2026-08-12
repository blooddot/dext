import type { WebviewRequest, WebviewResponse } from "../webviewProtocol.js";

export type LanguageResponse = Extract<WebviewResponse, { type: "language" }>;

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

interface PendingRequest {
  resolve(response: LanguageResponse | undefined): void;
  cancellation?: { dispose(): void };
}

export class LanguageRequestBroker {
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly post: (request: WebviewRequest) => void) {}

  request(
    source: string,
    cursor: number,
    cancellation?: CancellationLike
  ): Promise<LanguageResponse | undefined> {
    if (cancellation?.isCancellationRequested) return Promise.resolve(undefined);
    const requestId = ++this.requestId;
    return new Promise((resolve) => {
      const pending: PendingRequest = { resolve };
      if (cancellation) {
        pending.cancellation = cancellation.onCancellationRequested(() => {
          if (!this.pending.delete(requestId)) return;
          resolve(undefined);
        });
      }
      this.pending.set(requestId, pending);
      this.post({ type: "language", requestId, source, cursor });
    });
  }

  accept(message: WebviewResponse): boolean {
    if (message.type !== "language") return false;
    const pending = this.pending.get(message.requestId);
    if (!pending) return false;
    this.pending.delete(message.requestId);
    pending.cancellation?.dispose();
    pending.resolve(message);
    return true;
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      pending.cancellation?.dispose();
      pending.resolve(undefined);
    }
    this.pending.clear();
  }
}

export function sourceSnapshotMatches(currentSource: string, snapshotSource: string): boolean {
  return currentSource === snapshotSource;
}
