import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { DextStorage } from "../../../platform/vscode/dextStorage.js";
import { attachmentImageDataUrl } from "./attachmentImage.js";
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
}

const ANNOTATIONS_KEY = "dext.imageAnnotations";
/** Same order as `dext.attachments.maxFiles`: a picture Dext no longer keeps does
 * not need its marks kept, and a Memento write serializes this whole map. */
const MAX_SAVED_ANNOTATIONS = 200;

/** What one attachment keeps between visits: its marks, and the block the tab
 * last inserted for it. */
interface SavedAnnotation {
  marks?: unknown;
  inserted?: unknown;
}

/** One editor tab per attachment image: the page itself is the annotation
 * editor, so opening the tab is the whole interaction. */
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
      localResourceRoots: ["dist/webview", "media"].map((part) => vscode.Uri.joinPath(this.options.extensionUri, part))
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

  private async receive(panel: vscode.WebviewPanel, relativePath: string, message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const request = message as { type?: unknown; text?: unknown; marks?: unknown };
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
    const stamp = this.stamp();
    // A rebuilt bundle must be a new URL, or the Webview keeps the old script.
    const asset = (...parts: string[]): string =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.options.extensionUri, ...parts)).with({ query: `v=${stamp}` }).toString();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="dext-image-path" content="${escapeAttribute(relativePath)}">
  <meta name="dext-image-name" content="${escapeAttribute(name)}">
  <meta name="dext-image-marks" content="${escapeAttribute(this.savedMarks(relativePath))}">
  <link rel="stylesheet" href="${asset("dist", "webview", "main.css")}">
  <title>${escapeAttribute(name)}</title>
</head>
<body class="image-page">
  <script nonce="${nonce}" src="${asset("dist", "webview", "imageAnnotator.js")}"></script>
</body>
</html>`;
  }

  private savedMarks(relativePath: string): string {
    const marks = this.saved(relativePath).marks;
    return JSON.stringify(Array.isArray(marks) ? marks : []);
  }

  private stamp(): string {
    try {
      return String(statSync(vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview", "imageAnnotator.js").fsPath).mtimeMs);
    } catch {
      // Only reachable for a virtual or remote extension host, where
      // `asWebviewUri` already gives each asset a unique URL.
      return "0";
    }
  }
}
