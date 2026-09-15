import type { WebviewRequest, WebviewResponse } from "../webviewProtocol.js";
import type { ProjectReferenceCandidate } from "../core/projectReference.js";

/** Latest-query-wins picker transport. It never modifies the composer's source. */
export class ProjectReferenceClient {
  private nextRequestId = 0;
  private pending: { requestId: string; resolve: (items: ProjectReferenceCandidate[]) => void } | undefined;

  constructor(private readonly post: (request: WebviewRequest) => void, private readonly onError: (message: string) => void = () => {}) {}

  search(query: string): Promise<ProjectReferenceCandidate[]> {
    this.pending?.resolve([]);
    const requestId = String(++this.nextRequestId);
    return new Promise((resolve) => {
      this.pending = { requestId, resolve };
      this.post({ type: "searchProjectReferences", requestId, query });
    });
  }

  accept(response: WebviewResponse): boolean {
    if (response.type !== "projectReferenceSearchResult") return false;
    if (response.requestId !== this.pending?.requestId) return true;
    const { resolve } = this.pending;
    this.pending = undefined;
    if (response.error) this.onError(response.error);
    resolve(response.items);
    return true;
  }

  dispose(): void { this.pending?.resolve([]); this.pending = undefined; }
}
