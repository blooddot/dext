import type { WebviewRequest, WebviewResponse } from "../webviewProtocol.js";

export class FileDropClient {
  private nextRequestId = 0;
  private readonly pending = new Map<number, {
    resolve(expressions: string[]): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly post: (request: WebviewRequest) => void) {}

  resolve(paths: string[]): Promise<string[]> {
    if (paths.length > 100 || paths.some((path) => path.length > 8192)) {
      return Promise.reject(new Error("Drop at most 100 files with paths shorter than 8193 characters."));
    }
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Resolving dropped files timed out. Try dropping them again."));
      }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.post({ type: "resolveDroppedFiles", requestId, paths });
    });
  }

  accept(response: WebviewResponse): boolean {
    if (response.type !== "resolveDroppedFilesResult") return false;
    const pending = this.pending.get(response.requestId);
    if (!pending) return true;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.error) pending.reject(new Error(response.error));
    else pending.resolve(response.expressions);
    return true;
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve([]);
    }
    this.pending.clear();
  }
}
