import { ImageAnnotator } from "./imageAnnotator.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const meta = (name: string): string => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";

/** One image per tab, so one request: the host answers with the bytes as a
 * `data:` URL, which is what the pixel scan and the canvas need. */
const imageUrl = new Promise<string>((resolve, reject) => {
  window.addEventListener("message", (event: MessageEvent<{ type?: string; dataUrl?: string; error?: string }>) => {
    if (event.data?.type !== "imageDataResult") return;
    if (event.data.dataUrl) resolve(event.data.dataUrl);
    else reject(new Error(event.data.error ?? "The attachment image is empty."));
  });
  vscode.postMessage({ type: "imageData" });
});

const annotator = new ImageAnnotator({
  loadImage: () => imageUrl,
  onInsert: (text) => vscode.postMessage({ type: "insertAnnotations", text })
});

annotator.open(meta("dext-image-path"), meta("dext-image-name"));
