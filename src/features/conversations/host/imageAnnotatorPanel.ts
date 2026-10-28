import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import * as vscode from "vscode";
import type { DextStorage } from "../../../platform/vscode/dextStorage.js";
import { attachmentImageDataUrl } from "./attachmentImage.js";

export interface ImageAnnotatorPanelOptions {
  extensionUri: vscode.Uri;
  storage: DextStorage;
  /** Receives the composed annotation block. `previous` is the block this tab
   * inserted for the same attachment last time, so re-annotating replaces it
   * instead of stacking a second copy in the Input. */
  onInsert(text: string, previous?: string): void;
}

const escapeAttribute = (value: string): string => value.replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** One editor tab per attachment image: the picture at full size plus the same
 * annotation overlay the composer used to open as a modal dialog. */
export class ImageAnnotatorPanel {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly inserted = new Map<string, string>();

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
    const request = message as { type?: unknown; text?: unknown };
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
      const previous = this.inserted.get(relativePath);
      this.inserted.set(relativePath, request.text);
      this.options.onInsert(request.text, previous);
    }
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
  <link rel="stylesheet" href="${asset("dist", "webview", "main.css")}">
  <title>${escapeAttribute(name)}</title>
</head>
<body class="image-page">
  <div class="image-page-toolbar">
    <span class="image-page-name">${escapeAttribute(name)}</span>
    <button id="annotate" class="image-page-annotate" type="button" disabled>Annotate image</button>
  </div>
  <div class="image-page-stage"><img id="preview" alt="${escapeAttribute(name)}"></div>
  <p id="error" class="image-page-error" hidden></p>
  <script nonce="${nonce}" src="${asset("dist", "webview", "imageAnnotator.js")}"></script>
</body>
</html>`;
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
