import { parseMarks } from "./imageAnnotation.js";
import { ImageAnnotator } from "./imageAnnotator.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const lifecycle = new AbortController();
const meta = (name: string): string => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";

/** One image per tab, so one request: the host answers with the bytes as a
 * `data:` URL, which is what the pixel scan and the canvas need. */
const imageUrl = new Promise<string>((resolve, reject) => {
  const abort = (): void => reject(new DOMException("This operation was aborted", "AbortError"));
  lifecycle.signal.addEventListener("abort", abort, { once: true });
  window.addEventListener("message", (event: MessageEvent<{ type?: string; dataUrl?: string; error?: string }>) => {
    if (event.data?.type !== "imageDataResult") return;
    lifecycle.signal.removeEventListener("abort", abort);
    if (event.data.dataUrl) resolve(event.data.dataUrl);
    else reject(new Error(event.data.error ?? "The attachment image is empty."));
  }, { signal: lifecycle.signal });
  vscode.postMessage({ type: "imageData" });
});

const annotator = new ImageAnnotator({
  loadImage: () => imageUrl,
  onInsert: (text) => vscode.postMessage({ type: "insertAnnotations", text }),
  marks: parseMarks(meta("dext-image-marks")),
  onMarks: (marks) => vscode.postMessage({ type: "saveAnnotations", marks })
});

annotator.open(meta("dext-image-path"), meta("dext-image-name"));
window.addEventListener("pagehide", () => { annotator.dispose(); lifecycle.abort(); }, { once: true });
