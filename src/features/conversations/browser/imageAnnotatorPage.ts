import { ImageAnnotator } from "./imageAnnotator.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const meta = (name: string): string => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
const relativePath = meta("dext-image-path");
const name = meta("dext-image-name");
const preview = document.querySelector<HTMLImageElement>("#preview")!;
const error = document.querySelector<HTMLElement>("#error")!;
const annotate = document.querySelector<HTMLButtonElement>("#annotate")!;

/** One image per tab, so one request: the host answers with the bytes as a
 * `data:` URL, which both the preview and the canvas can use. */
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

annotate.addEventListener("click", () => annotator.open(relativePath, name));

imageUrl.then((url) => {
  preview.src = url;
  annotate.disabled = false;
}, (failure: unknown) => {
  error.textContent = failure instanceof Error ? failure.message : String(failure);
  error.hidden = false;
});
