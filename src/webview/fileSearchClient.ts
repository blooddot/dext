import type { WebviewRequest, WebviewResponse } from "../webviewProtocol.js";

/** Request side of the composer's `@` file picker. Only the newest query is
 * kept: an in-flight lookup for text the user has already typed past would
 * otherwise repopulate the menu with stale paths. */
export class FileSearchClient {
  private nextRequestId = 0;
  private readonly pending = new Map<number, (files: string[]) => void>();

  constructor(private readonly post: (request: WebviewRequest) => void) {}

  search(query: string): Promise<string[]> {
    const requestId = ++this.nextRequestId;
    this.post({ type: "searchFiles", requestId, query });
    return new Promise((resolve) => this.pending.set(requestId, resolve));
  }

  accept(response: WebviewResponse): boolean {
    if (response.type !== "searchFilesResult") return false;
    const resolve = this.pending.get(response.requestId);
    if (!resolve) return true;
    this.pending.delete(response.requestId);
    resolve(response.files);
    return true;
  }

  dispose(): void {
    for (const resolve of this.pending.values()) resolve([]);
    this.pending.clear();
  }
}
