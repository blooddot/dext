import type { WebviewRequest, WebviewResponse } from "../webviewProtocol.js";

/** Request side of the composer's `@` file picker. Only the newest query is
 * kept: an in-flight lookup for text the user has already typed past would
 * otherwise repopulate the menu with stale paths. */
export class FileSearchClient {
  private nextRequestId = 0;
  private pending: { requestId: number; resolve: (files: string[]) => void } | undefined;

  constructor(private readonly post: (request: WebviewRequest) => void) {}

  search(query: string): Promise<string[]> {
    const requestId = ++this.nextRequestId;
    this.pending?.resolve([]);
    this.pending = undefined;
    this.post({ type: "searchFiles", requestId, query });
    return new Promise((resolve) => { this.pending = { requestId, resolve }; });
  }

  accept(response: WebviewResponse): boolean {
    if (response.type !== "searchFilesResult") return false;
    if (this.pending?.requestId !== response.requestId) return true;
    const resolve = this.pending.resolve;
    this.pending = undefined;
    resolve(response.files);
    return true;
  }

  dispose(): void {
    this.pending?.resolve([]);
    this.pending = undefined;
  }
}
