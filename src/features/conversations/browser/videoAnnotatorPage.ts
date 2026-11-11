import { parseFrameMarks } from "./videoAnnotation.js";
import { VideoAnnotator } from "./videoAnnotator.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const meta = (name: string): string => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";

interface FrameImageResult {
  type?: string;
  requestId?: number;
  relativePath?: string;
  error?: string;
}

/** One still at a time: the page waits for the host to store it before it seeks
 * to the next frame, so a slow disk never piles up exports. */
const pendingFrames = new Map<number, { resolve: (relativePath: string) => void; reject: (error: Error) => void }>();
let nextFrameRequest = 0;

window.addEventListener("message", (event: MessageEvent<FrameImageResult>) => {
  const message = event.data;
  if (message?.type !== "frameImageResult" || typeof message.requestId !== "number") return;
  const pending = pendingFrames.get(message.requestId);
  if (!pending) return;
  pendingFrames.delete(message.requestId);
  if (message.relativePath) pending.resolve(message.relativePath);
  else pending.reject(new Error(message.error ?? "The frame image could not be stored."));
});

const storeFrame = (data: string, mimeType: string): Promise<string> => new Promise((resolve, reject) => {
  const requestId = ++nextFrameRequest;
  pendingFrames.set(requestId, { resolve, reject });
  vscode.postMessage({ type: "frameImage", requestId, data, mimeType });
});

const annotator = new VideoAnnotator({
  path: meta("dext-video-path"),
  source: meta("dext-video-src"),
  frames: parseFrameMarks(meta("dext-video-marks")),
  storeFrame,
  onFrames: (frames) => vscode.postMessage({ type: "saveVideoFrames", frames }),
  onInsert: (text) => vscode.postMessage({ type: "insertAnnotations", text })
});

annotator.open();
