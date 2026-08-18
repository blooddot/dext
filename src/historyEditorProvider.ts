import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DextHistoryStore } from "./historyStore.js";
import { historyTokenStyles, renderHistorySession } from "./historyRender.js";
import { loadEditorTokenTheme } from "./vscodeTheme.js";
import { openWorkspaceFileReference } from "./vscodeContextHost.js";

export class DextHistoryPanel implements vscode.Disposable {
  static readonly viewType = "dext.history";
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly history: DextHistoryStore
  ) {}

  showInActiveEditor(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      this.render();
      return Promise.resolve();
    }
    this.panel = vscode.window.createWebviewPanel(
      DextHistoryPanel.viewType,
      "Dext History",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist"),
          vscode.Uri.joinPath(this.extensionUri, "media")
        ]
      }
    );
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as { type?: string; text?: string; reference?: string };
      if (message.type === "copy" && typeof message.text === "string") {
        void vscode.env.clipboard.writeText(message.text);
      }
      if (message.type === "openFileReference" && typeof message.reference === "string") {
        void openWorkspaceFileReference(message.reference);
      }
    });
    this.render();
    return Promise.resolve();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private render(): void {
    if (!this.panel) return;
    this.panel.webview.html = this.html(this.panel.webview);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "styles.css"));
    const sessions = this.history.list();
    const body = sessions.length
      ? sessions.map(renderHistorySession).join("\n")
      : `<div class="history-empty">No Dext history yet.</div>`;
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codicons.toString()}">
  <link rel="stylesheet" href="${style.toString()}">
  <style>${historyTokenStyles(loadEditorTokenTheme())}</style>
  <title>Dext History</title>
</head>
<body>
  <section class="history-view" aria-label="Dext History">
    <div class="history-content">${body}</div>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const modeButton = target?.closest('button[data-diff-mode]');
      if (modeButton) {
        event.preventDefault();
        event.stopPropagation();
        const container = modeButton.closest('[data-diff-container]');
        const mode = modeButton.dataset.diffMode;
        if (container && (mode === 'inline' || mode === 'split')) {
          container.querySelector('.diff-view').dataset.diffView = mode;
          container.querySelectorAll('.diff-mode-button').forEach((button) => {
            const active = button.dataset.diffMode === mode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
          });
        }
        return;
      }
      const copyButton = target?.closest('button[data-copy]');
      if (copyButton) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: 'copy', text: copyButton.dataset.copy || '' });
        copyButton.classList.remove('codicon-copy');
        copyButton.classList.add('codicon-check');
        setTimeout(() => {
          copyButton.classList.remove('codicon-check');
          copyButton.classList.add('codicon-copy');
        }, 900);
        return;
      }
      const reference = target?.closest('button[data-open-file-reference]');
      if (reference) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: 'openFileReference', reference: reference.dataset.openFileReference || '' });
      }
    });
  </script>
</body>
</html>`;
  }
}
