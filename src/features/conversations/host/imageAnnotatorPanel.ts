import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { DextStorage } from "../../../platform/vscode/dextStorage.js";
import { attachmentImageDataUrl, isVideoAttachment } from "./attachmentImage.js";
import { escapeHtml as escapeAttribute } from "../../../shared/lib/html.js";

export interface ImageAnnotatorPanelOptions {
  extensionUri: vscode.Uri;
  storage: DextStorage;
  /** Marks survive a closed tab in Dext's extension state. Absent in hostless
   * tests, where the tab simply starts empty. */
  state?: Pick<vscode.Memento, "get" | "update">;
  /** Receives the composed annotation block. `previous` is the block this tab
   * inserted for the same attachment last time, so re-annotating replaces it
   * instead of stacking a second copy in the Input. */
  onInsert(text: string, previous?: string): void;
  /** Stores a still a video tab cut out of its own player. Absent in hostless
   * tests, where the tab simply cannot export frames. */
  storeFrame?(data: string, mimeType: string): Promise<{ relativePath: string }>;
}

const ANNOTATIONS_KEY = "dext.imageAnnotations";
/** Same order as `dext.attachments.maxFiles`: a picture Dext no longer keeps does
 * not need its marks kept, and a Memento write serializes this whole map. */
const MAX_SAVED_ANNOTATIONS = 200;

/** What one attachment keeps between visits: its marks, and the block the tab
 * last inserted for it. A video keeps `frames` instead of `marks`, which is one
 * marks array per moment of the video. */
interface SavedAnnotation {
  marks?: unknown;
  inserted?: unknown;
  frames?: unknown;
}

/** A message from the annotation page. Each field is validated where it is used. */
interface AnnotatorRequest {
  type?: unknown;
  text?: unknown;
  marks?: unknown;
  frames?: unknown;
  data?: unknown;
  mimeType?: unknown;
  requestId?: unknown;
}

/** One editor tab per attachment: the page itself is the annotation editor, so
 * opening the tab is the whole interaction. An image shows a still, a video shows
 * a player; both keep their notes per attachment. */
export class ImageAnnotatorPanel {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /** The saved map, read from the Memento once so two open tabs cannot overwrite
   * each other's attachment. */
  private cache?: Record<string, SavedAnnotation>;

  constructor(private readonly options: ImageAnnotatorPanelOptions) {}

  open(relativePath: string): void {
    const openPanel = this.panels.get(relativePath);
    if (openPanel) {
      openPanel.reveal();
      return;
    }
    const name = basename(relativePath);
    const panel = vscode.window.createWebviewPanel("dext.imageAnnotator", name, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: this.resourceRoots()
    });
    this.panels.set(relativePath, panel);
    panel.onDidDispose(() => this.panels.delete(relativePath));
    panel.webview.onDidReceiveMessage((message: unknown) => void this.receive(panel, relativePath, message));
    panel.webview.html = this.html(panel.webview, relativePath, name);
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }

  /** The tab's own assets plus the attachments directory: a video page plays a
   * file from there, and the Webview refuses anything outside these roots. */
  private resourceRoots(): vscode.Uri[] {
    const roots = ["dist/webview", "media"].map((part) => vscode.Uri.joinPath(this.options.extensionUri, part));
    try {
      roots.push(this.options.storage.directory("attachments"));
    } catch {
      // A workspace-located store with no workspace open: the page still opens
      // and reports the missing video itself.
    }
    return roots;
  }

  private async receive(panel: vscode.WebviewPanel, relativePath: string, message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const request = message as AnnotatorRequest;
    if (request.type === "imageData") {
      try {
        await panel.webview.postMessage({
          type: "imageDataResult",
          dataUrl: await attachmentImageDataUrl(this.options.storage, relativePath)
        });
      } catch (failure) {
        await panel.webview.postMessage({
          type: "imageDataResult",
          error: failure instanceof Error ? failure.message : String(failure)
        });
      }
      return;
    }
    if (request.type === "insertAnnotations" && typeof request.text === "string") {
      const saved = this.saved(relativePath).inserted;
      // The Input hears about the block before the state write completes: the
      // insertion is the visible effect, and `previous` came from the read above.
      this.options.onInsert(request.text, typeof saved === "string" ? saved : undefined);
      await this.store(relativePath, { inserted: request.text });
      return;
    }
    if (request.type === "saveAnnotations" && Array.isArray(request.marks)) {
      // shortcut: every keystroke rewrites the map, which is small enough for a
      // handful of screenshot marks; debounce it if a picture ever carries hundreds.
      await this.store(relativePath, { marks: request.marks });
      return;
    }
    if (request.type === "saveVideoFrames" && Array.isArray(request.frames)) {
      // One frame's marks change on every note keystroke, exactly like a picture's.
      await this.store(relativePath, { frames: request.frames });
      return;
    }
    if (request.type === "frameImage" && typeof request.data === "string" && typeof request.mimeType === "string") {
      const requestId = typeof request.requestId === "number" ? request.requestId : 0;
      try {
        if (!this.options.storeFrame) throw new Error("Dext cannot store video frames here.");
        const stored = await this.options.storeFrame(request.data, request.mimeType);
        await panel.webview.postMessage({ type: "frameImageResult", requestId, relativePath: stored.relativePath });
      } catch (failure) {
        await panel.webview.postMessage({
          type: "frameImageResult",
          requestId,
          error: failure instanceof Error ? failure.message : String(failure)
        });
      }
    }
  }

  private saved(relativePath: string): SavedAnnotation {
    return this.savedAll()[relativePath] ?? {};
  }

  private savedAll(): Record<string, SavedAnnotation> {
    return this.cache ??= { ...(this.options.state?.get<Record<string, SavedAnnotation>>(ANNOTATIONS_KEY, {}) ?? {}) };
  }

  private async store(relativePath: string, entry: SavedAnnotation): Promise<void> {
    const all = this.savedAll();
    const next = { ...all[relativePath], ...entry };
    // Re-inserting moves the attachment to the end, so the front is the oldest use.
    delete all[relativePath];
    all[relativePath] = next;
    const paths = Object.keys(all);
    for (const path of paths.slice(0, Math.max(0, paths.length - MAX_SAVED_ANNOTATIONS))) delete all[path];
    await this.options.state?.update(ANNOTATIONS_KEY, { ...all });
  }

  private html(webview: vscode.Webview, relativePath: string, name: string): string {
    const nonce = randomBytes(16).toString("base64");
    const video = isVideoAttachment(relativePath);
    const bundle = video ? "videoAnnotator.js" : "imageAnnotator.js";
    const stamp = this.stamp(bundle);
    // A rebuilt bundle must be a new URL, or the Webview keeps the old script.
    const asset = (...parts: string[]): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.options.extensionUri, ...parts)).with({ query: `v=${stamp}` }).toString();
    // A video page fetches the file to get a same-origin `blob:` for the canvas,
    // so it needs both `connect-src` (the fetch) and `media-src` (the playback).
    const csp = video
      ? `default-src 'none'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource} blob:; connect-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`
      : `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const heading = video
      ? `<meta name="dext-video-path" content="${escapeAttribute(relativePath)}">
  <meta name="dext-video-name" content="${escapeAttribute(name)}">
  <meta name="dext-video-src" content="${escapeAttribute(this.videoSource(webview, relativePath))}">
  <meta name="dext-video-marks" content="${escapeAttribute(this.savedFrames(relativePath))}">`
      : `<meta name="dext-image-path" content="${escapeAttribute(relativePath)}">
  <meta name="dext-image-name" content="${escapeAttribute(name)}">
  <meta name="dext-image-marks" content="${escapeAttribute(this.savedMarks(relativePath))}">`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${heading}
  <link rel="stylesheet" href="${asset("dist", "webview", "main.css")}">
  <title>${escapeAttribute(name)}</title>
</head>
<body class="image-page${video ? " video-page" : ""}">
  <script nonce="${nonce}" src="${asset("dist", "webview", bundle)}"></script>
</body>
</html>`;
  }

  /** The attachment's own Webview URL: the page fetches it and plays the bytes as
   * a `blob:`, which is what keeps its canvas untainted. */
  private videoSource(webview: vscode.Webview, relativePath: string): string {
    const uri = this.options.storage.uriForReference("attachments", relativePath);
    return uri ? webview.asWebviewUri(uri).toString() : "";
  }

  private savedFrames(relativePath: string): string {
    const frames = this.saved(relativePath).frames;
    return JSON.stringify(Array.isArray(frames) ? frames : []);
  }

  private savedMarks(relativePath: string): string {
    const marks = this.saved(relativePath).marks;
    return JSON.stringify(Array.isArray(marks) ? marks : []);
  }

  private stamp(bundle: string): string {
    try {
      return String(statSync(vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview", bundle).fsPath).mtimeMs);
    } catch {
      // Only reachable for a virtual or remote extension host, where
      // `asWebviewUri` already gives each asset a unique URL.
      return "0";
    }
  }
}
