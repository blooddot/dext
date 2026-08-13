import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DextHistoryStore } from "./historyStore.js";
import { historyTokenStyles, renderHistoryRecord } from "./historyRender.js";
import { loadEditorTokenTheme } from "./vscodeTheme.js";

export class DextHistoryPanel implements vscode.Disposable {
  private static current: DextHistoryPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: DextHistoryStore
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "dext.history",
      "Dext History",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      if (DextHistoryPanel.current === this) DextHistoryPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== "object") return;
      const data = message as { type?: string; text?: string };
      if (data.type === "copy" && typeof data.text === "string") {
        void vscode.env.clipboard.writeText(data.text);
      }
    });
  }

  static show(extensionUri: vscode.Uri, store: DextHistoryStore): void {
    if (!DextHistoryPanel.current) DextHistoryPanel.current = new DextHistoryPanel(extensionUri, store);
    else DextHistoryPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    DextHistoryPanel.current.render();
  }

  private render(): void {
    const nonce = randomBytes(16).toString("base64");
    const codicons = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css")
    );
    const records = [...this.store.list()].reverse();
    const body = records.length
      ? records.map(renderHistoryRecord).join("\n")
      : `<div class="empty">No Dext history yet.</div>`;
    const tokenStyles = historyTokenStyles(loadEditorTokenTheme());
    this.panel.webview.html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; font-src ${this.panel.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${codicons.toString()}"><style>
      :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:18px 22px 32px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family)}h1{font-size:16px;font-weight:600;margin:0 0 14px}.history-record{border-top:1px solid var(--vscode-panel-border)}summary{list-style:none}summary::-webkit-details-marker{display:none}.history-record>summary,.history-disclosure>summary{min-height:30px;display:flex;align-items:center;gap:5px;padding:2px 4px;cursor:pointer;user-select:none;border-radius:3px}.history-record>summary:hover,.history-disclosure>summary:hover{background:var(--vscode-list-hoverBackground)}.disclosure-chevron{width:12px;flex:0 0 12px;color:var(--vscode-descriptionForeground);font-size:12px;transition:transform 60ms linear}details[open]>summary>.disclosure-chevron{transform:rotate(90deg)}.history-summary-input{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground)}.history-meta{margin-left:4px;color:var(--vscode-descriptionForeground);font-size:11px}.history-record-body{padding:2px 0 12px 16px}.history-disclosure{margin:2px 0}.history-disclosure>.disclosure-body,.history-disclosure>.dext-source{margin-left:16px}.disclosure-body{padding:2px 0 6px}.execution-heading{display:flex;align-items:center;gap:6px;color:var(--vscode-descriptionForeground);font-size:11px}.execution-heading .copy-button{margin-left:auto}.history-execution{padding:8px 4px;border-bottom:1px solid var(--vscode-panel-border)}.history-execution p{margin:7px 0;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}.history-execution>.history-disclosure{margin:4px 0}.history-disclosure.file-change,.history-disclosure.process-event{border:1px solid var(--vscode-widget-border);border-radius:4px;overflow:hidden}.history-disclosure.file-change>summary,.history-disclosure.process-event>summary{padding:4px 7px}.process-group>.disclosure-body{padding-left:16px}.process-text{padding:4px;color:var(--vscode-foreground);white-space:pre-wrap;overflow-wrap:anywhere}.file-path{padding:5px 8px;border-top:1px solid var(--vscode-widget-border);color:var(--vscode-descriptionForeground);font-size:11px;overflow-wrap:anywhere}.diff{padding:7px 8px}.diff .removed{color:var(--vscode-gitDecoration-deletedResourceForeground,var(--vscode-errorForeground))}.diff .added{color:var(--vscode-gitDecoration-addedResourceForeground,var(--vscode-testing-iconPassed))}.finding{padding:4px 0}.finding.error,.error{color:var(--vscode-errorForeground)}.finding.warning{color:var(--vscode-editorWarning-foreground)}.finding.info{color:var(--vscode-editorInfo-foreground)}.result-state{color:var(--vscode-descriptionForeground)}pre{margin:0;padding:6px 8px;max-height:420px;overflow:auto;border:0;color:var(--vscode-editor-foreground);background:transparent;font:12px/1.45 var(--vscode-editor-font-family);white-space:pre-wrap;overflow-wrap:anywhere}.dext-source{padding:8px 4px;white-space:pre;font-weight:400}.terminal-text{color:var(--vscode-terminal-foreground,var(--vscode-editor-foreground))}.copy-button{margin-left:auto;width:22px;height:22px;border:0;color:var(--vscode-descriptionForeground);background:transparent;cursor:pointer;opacity:0}.history-disclosure>summary:hover .copy-button,.execution-heading:hover .copy-button,.copy-button:focus{opacity:1}.copy-button:hover{color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground)}ol{margin:6px 0;padding-left:24px}li small{display:block;color:var(--vscode-descriptionForeground)}.empty{color:var(--vscode-descriptionForeground);padding:20px 0}${tokenStyles}
    </style></head><body><h1>Dext History</h1>${body}<script nonce="${nonce}">
      const vscode = acquireVsCodeApi(); document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); vscode.postMessage({type:'copy', text: button.dataset.copy || ''}); button.classList.remove('codicon-copy'); button.classList.add('codicon-check'); setTimeout(() => { button.classList.remove('codicon-check'); button.classList.add('codicon-copy'); }, 900); }));
    </script></body></html>`;
  }

  dispose(): void {
    this.panel.dispose();
  }
}
