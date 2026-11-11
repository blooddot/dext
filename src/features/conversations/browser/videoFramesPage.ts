import { MAX_FRAME_LONG_EDGE, type VideoFrameCapture } from "../contracts/videoFrames.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
const meta = (name: string): string => document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
const QUALITY = 0.8;

/** The largest a still may be: the whole player is downscaled, never upscaled. */
function snapshot(video: HTMLVideoElement): string {
  const scale = Math.min(1, MAX_FRAME_LONG_EDGE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The frame could not be captured in this editor.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", QUALITY);
  // The host stores and forwards raw base64, the same shape a pasted image has.
  return url.slice(url.indexOf(",") + 1);
}

/** Resolves with the moment actually reached: a seek to the end lands one frame
 * short of it, and the still would otherwise be labelled with a time it is not. */
function seek(video: HTMLVideoElement, ms: number): Promise<number> {
  const end = Number.isFinite(video.duration) ? video.duration * 1000 : 0;
  const target = Math.min(Math.max(0, ms), Math.max(0, end - 1));
  if (Math.abs(video.currentTime * 1000 - target) < 1) return Promise.resolve(target);
  return new Promise((resolve) => {
    const done = (): void => {
      video.removeEventListener("seeked", done);
      resolve(target);
    };
    video.addEventListener("seeked", done);
    video.currentTime = target / 1000;
  });
}

/** Stills for the moments the host listed, then one message back and no more: the
 * host owns this page's whole lifetime and closes it on the answer. */
async function capture(): Promise<void> {
  try {
    const source = meta("dext-frames-src");
    if (!source) throw new Error("This video file is missing.");
    const times = JSON.parse(meta("dext-frames-times")) as number[];
    const response = await fetch(source);
    if (!response.ok) throw new Error(`The video could not be read (${response.status}).`);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    // Playing the bytes from a `blob:` keeps the canvas same-origin: a
    // `vscode-webview:` source would taint it and `toDataURL` would throw.
    // shortcut: the whole file lands in this page's memory, so a 100 MB video
    // costs that much for the length of one capture.
    const blob = URL.createObjectURL(await response.blob());
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error(
        "This video's codec cannot be decoded in the editor. Convert it to MP4/H.264 and try again."
      ));
      video.src = blob;
    });
    const captured: VideoFrameCapture = {
      durationMs: Number.isFinite(video.duration) ? Math.max(0, Math.round(video.duration * 1000)) : 0,
      width: video.videoWidth,
      height: video.videoHeight,
      frames: []
    };
    for (const ms of times) {
      const timeMs = await seek(video, ms);
      captured.frames.push({ timeMs, data: snapshot(video) });
    }
    vscode.postMessage({ type: "frames", capture: captured });
  } catch (failure) {
    vscode.postMessage({ type: "frames", error: failure instanceof Error ? failure.message : String(failure) });
  }
}

void capture();
