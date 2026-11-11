import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as vscode from "vscode";
import type { DextStorage } from "../../../platform/vscode/dextStorage.js";
import { escapeHtml as escapeAttribute } from "../../../shared/lib/html.js";
import { isVideoAttachment } from "./attachmentImage.js";
import type { VideoFrameCapture } from "../contracts/videoFrames.js";

/** A page that never answers would hold an editor tab open forever. */
const CAPTURE_TIMEOUT_MS = 60_000;

export interface VideoFramesOptions {
  extensionUri: vscode.Uri;
  storage: DextStorage;
}

/** Turns a video into stills for an agent. VS Code only decodes video in a live
 * Webview, so each capture opens its own tab, takes the stills and closes it. */
export class VideoFrames {
  constructor(private readonly options: VideoFramesOptions) {}

  /** `path` is what the composer shows the reader — `.dext/attachments/x.mp4`, or
   * any file the workspace can reach. */
  async capture(path: string, timesSeconds: readonly number[]): Promise<VideoFrameCapture> {
    const uri = this.resolve(path);
    const panel = vscode.window.createWebviewPanel("dext.videoFrames", "Video frames", {
      // Focus stays where the reader left it; only the tab appears, and it closes
      // as soon as the stills are in.
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true
    }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview"), sibling(uri)]
    });
    try {
      const capture = new Promise<VideoFrameCapture>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The video frames did not arrive in time.")), CAPTURE_TIMEOUT_MS);
        const subscription = panel.webview.onDidReceiveMessage((message: unknown) => {
          const answer = message as { type?: unknown; capture?: unknown; error?: unknown } | undefined;
          if (answer?.type !== "frames") return;
          clearTimeout(timer);
          subscription.dispose();
          if (typeof answer.error === "string") reject(new Error(answer.error));
          else resolve(captureFrom(answer.capture));
        });
      });
      panel.webview.html = this.html(panel.webview, uri, timesSeconds);
      return await capture;
    } finally {
      panel.dispose();
    }
  }

  private resolve(path: string): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const uri = this.options.storage.uriForReference("attachments", path)
      ?? vscode.Uri.file(isAbsolute(path) ? path : join(root, path));
    if (!isVideoAttachment(uri.fsPath)) {
      throw new Error(`'${path}' is not a video Dext can decode (.mp4, .m4v, .mov, .webm).`);
    }
    return uri;
  }

  private html(webview: vscode.Webview, uri: vscode.Uri, timesSeconds: readonly number[]): string {
    const nonce = randomBytes(16).toString("base64");
    const script = this.asset(webview, "videoFrames.js");
    // The page fetches the file to get a same-origin `blob:` for the canvas, so it
    // needs both `connect-src` (the fetch) and `media-src` (the decoding).
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${webview.cspSource} blob:; connect-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="dext-frames-src" content="${escapeAttribute(webview.asWebviewUri(uri).toString())}">
  <meta name="dext-frames-times" content="${escapeAttribute(JSON.stringify(timesSeconds.map((time) => Math.round(time * 1000))))}">
  <title>Video frames</title>
</head>
<body>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private asset(webview: vscode.Webview, bundle: string): string {
    const path = vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview", bundle);
    let stamp = "0";
    try {
      // A rebuilt bundle must be a new URL, or the Webview keeps the old script.
      stamp = String(statSync(path.fsPath).mtimeMs);
    } catch {
      // Only a virtual or remote extension host reaches this; `asWebviewUri`
      // already gives each asset a unique URL there.
    }
    return webview.asWebviewUri(path).with({ query: `v=${stamp}` }).toString();
  }
}

/** The video's own directory: the Webview refuses a URL outside its roots. */
function sibling(uri: vscode.Uri): vscode.Uri {
  const cut = uri.path.lastIndexOf("/");
  return cut <= 0 ? uri : uri.with({ path: uri.path.slice(0, cut) });
}

/** The page's answer crosses the Webview bridge, so it is trusted only once it
 * has the shape this host asked for. */
function captureFrom(value: unknown): VideoFrameCapture {
  const record = value as Partial<VideoFrameCapture> | undefined;
  if (typeof record?.durationMs !== "number" || typeof record.width !== "number" || typeof record.height !== "number") {
    throw new Error("The captured frames could not be read.");
  }
  const frames = (Array.isArray(record.frames) ? record.frames : []).flatMap((frame) =>
    typeof frame?.timeMs === "number" && typeof frame.data === "string" ? [{ timeMs: frame.timeMs, data: frame.data }] : []);
  return { durationMs: record.durationMs, width: record.width, height: record.height, frames };
}
