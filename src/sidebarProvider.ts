import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DextApplication } from "./application.js";
import { webviewRequestSchema } from "./webviewProtocol.js";
import type { WebviewResponse } from "./webviewProtocol.js";

export class DextSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "dext.sidebar";
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly application: DextApplication
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw));
  }

  async refresh(): Promise<void> {
    await this.post({ type: "state", state: this.application.state() });
  }

  focusEditor(): void {
    void this.post({ type: "focusEditor" });
  }

  private async receive(raw: unknown): Promise<void> {
    const parsed = webviewRequestSchema.safeParse(raw);
    if (!parsed.success) {
      await this.post({ type: "error", message: "Invalid Webview request." });
      return;
    }
    const request = parsed.data;
    try {
      switch (request.type) {
        case "ready":
          await this.refresh();
          break;
        case "language": {
          const diagnostics = request.source.trim()
            ? this.application.language.diagnostics(request.source)
            : [];
          const signature = this.application.language.signature(request.source, request.cursor);
          await this.post({
            type: "language",
            requestId: request.requestId,
            completions: this.application.language.completions(request.source, request.cursor),
            diagnostics,
            ...(signature ? { signature } : {})
          });
          break;
        }
        case "executeCode":
          await this.run(() => this.application.executeCode(request.source));
          break;
        case "executeChat":
          await this.run(() => this.application.executeChat(request.message));
          break;
        case "reload":
          await this.application.reload();
          await this.refresh();
          break;
      }
    } catch (error) {
      await this.post({
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async run(execute: () => Promise<Awaited<ReturnType<DextApplication["executeCode"]>>>): Promise<void> {
    await this.post({ type: "executing", value: true });
    try {
      await this.post({ type: "execution", response: await execute() });
    } finally {
      await this.post({ type: "executing", value: false });
    }
  }

  private async post(message: WebviewResponse): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "styles.css"));
    const codicons = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css")
    );
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codicons.toString()}">
  <link rel="stylesheet" href="${style.toString()}">
  <title>Dext</title>
</head>
<body>
  <header class="toolbar">
    <strong>Dext</strong>
    <div class="toolbar-actions">
      <span id="trust-status" class="status-dot" title="Workspace trust"></span>
      <button id="reload" class="icon-button" type="button" title="Reload methods" aria-label="Reload methods"><i class="codicon codicon-refresh"></i></button>
    </div>
  </header>

  <main>
    <div class="mode-switch" role="tablist" aria-label="Input mode">
      <button id="code-mode" class="mode active" role="tab" aria-selected="true">Code</button>
      <button id="chat-mode" class="mode" role="tab" aria-selected="false">Chat</button>
    </div>

    <section id="code-panel" class="input-panel">
      <div class="editor-shell">
        <textarea id="code-input" rows="7" spellcheck="false" autocomplete="off" aria-label="Dext method call" placeholder="core.code.review("></textarea>
        <div id="completions" class="completions hidden" role="listbox"></div>
      </div>
      <div id="signature" class="signature"></div>
      <div id="diagnostics" class="diagnostics"></div>
    </section>

    <section id="chat-panel" class="input-panel hidden">
      <textarea id="chat-input" rows="5" aria-label="Chat message" placeholder="Message"></textarea>
    </section>

    <div class="action-row">
      <button id="run" class="primary" type="button"><i class="codicon codicon-run"></i><span>Run</span></button>
      <span id="run-state" role="status"></span>
    </div>

    <section id="result-section" class="result-section hidden" aria-live="polite">
      <div class="section-heading">
        <span>Output</span>
        <button id="clear-output" class="icon-button" type="button" title="Clear output" aria-label="Clear output"><i class="codicon codicon-close"></i></button>
      </div>
      <div id="result"></div>
    </section>

    <section class="methods-section">
      <div class="section-heading"><span>Methods</span><span id="method-count" class="count"></span></div>
      <div id="config-errors" class="config-errors"></div>
      <div id="methods"></div>
    </section>
  </main>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
