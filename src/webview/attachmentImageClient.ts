import type { WebviewRequest, WebviewResponse } from "../platform/webviewProtocol.js";

/** Pixels for the annotation canvas. The image chip's `vscode-webview` URL would
 * taint a canvas, so the host reads the file and answers with a `data:` URL. */
export class AttachmentImageClient {
  private nextRequestId = 0;
  private readonly pending = new Map<number, {
    resolve(dataUrl: string): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly post: (request: WebviewRequest) => void) {}

  load(relativePath: string): Promise<string> {
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Reading the attachment image timed out."));
      }, 15000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.post({ type: "imageData", requestId, relativePath });
    });
  }

  accept(response: WebviewResponse): boolean {
    if (response.type !== "imageDataResult") return false;
    const pending = this.pending.get(response.requestId);
    if (!pending) return true;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.error || !response.dataUrl) pending.reject(new Error(response.error ?? "The attachment image is empty."));
    else pending.resolve(response.dataUrl);
    return true;
  }
}
