import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DextApplication } from "./application.js";
import {
  AttachmentStore,
  writeExactClipboardText
} from "./attachmentStore.js";
import {
  attachmentFileReference,
  clipboardFileReference,
  fileAttachment,
  selectionAttachment
} from "./vscodeAttachments.js";
import { ReadyMessageQueue } from "./readyMessageQueue.js";
import { openWorkspaceFileReference } from "./vscodeContextHost.js";
import { webviewRequestSchema } from "./webviewProtocol.js";
import type { WebviewResponse } from "./webviewProtocol.js";

export class DextSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "dext.sidebar";
  private view: vscode.WebviewView | undefined;
  private readonly messageQueue = new ReadyMessageQueue<WebviewResponse>();
  private readonly attachments = new AttachmentStore();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly application: DextApplication
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.messageQueue.markNotReady();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media")
      ]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.messageQueue.markNotReady();
      }
    });
  }

  async refresh(): Promise<void> {
    await this.post({ type: "state", state: this.application.state() });
  }

  focusEditor(): void {
    this.postWhenReady({ type: "focusEditor" });
  }

  triggerSuggest(): void {
    this.postWhenReady({ type: "triggerSuggest" });
  }

  triggerParameterHints(): void {
    this.postWhenReady({ type: "triggerParameterHints" });
  }

  showChat(): void {
    this.postWhenReady({ type: "focusInput" });
  }

  async addSelectionToChat(): Promise<void> {
    const attachment = await selectionAttachment();
    this.postWhenReady({
      type: "insertFileReferences",
      expressions: [attachmentFileReference(attachment).expression]
    });
  }

  async copySelectionWithContext(): Promise<string> {
    const attachment = await selectionAttachment();
    const copiedText = await writeExactClipboardText(vscode.env.clipboard, attachment.text);
    this.attachments.stageClipboard(attachment.text, attachment.reference);
    return copiedText;
  }

  async addFileToChat(resource?: vscode.Uri): Promise<void> {
    const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) throw new Error("Choose a workspace file before adding it to Dext input.");
    const attachment = await fileAttachment(uri);
    this.postWhenReady({
      type: "insertFileReferences",
      expressions: [attachmentFileReference(attachment).expression]
    });
  }

  dispose(): void {
    this.attachments.dispose();
    this.messageQueue.clear();
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
        case "ready": {
          const pendingMessages = this.messageQueue.markReady();
          await this.refresh();
          await this.flushPendingMessages(pendingMessages);
          break;
        }
        case "language": {
          const diagnostics = request.source.trim()
            ? this.application.language.documentDiagnostics(request.source)
            : [];
          const signature = this.application.language.documentSignature(request.source, request.cursor);
          const hover = this.application.language.documentHover(request.source, request.cursor);
          await this.post({
            type: "language",
            requestId: request.requestId,
            completions: this.application.language.documentCompletions(request.source, request.cursor),
            diagnostics,
            inputKind: request.source.trim()
              ? (diagnostics.some((item) => item.severity === "error") ? "invalid" : "workflow")
              : "empty",
            ...(signature ? { signature } : {}),
            ...(hover ? { hover } : {})
          });
          break;
        }
        case "executeInput":
          await this.run(() => this.application.executeInput(request.source));
          break;
        case "openFileReference":
          await openWorkspaceFileReference(request.reference);
          break;
        case "clipboardWrite": {
          try {
            await vscode.env.clipboard.writeText(request.text);
            await this.post({
              type: "clipboardWriteResult",
              requestId: request.requestId,
              success: true
            });
          } catch (error) {
            await this.post({
              type: "clipboardWriteResult",
              requestId: request.requestId,
              success: false
            });
            throw error;
          }
          break;
        }
        case "clipboardRead": {
          let text: string;
          try {
            text = await vscode.env.clipboard.readText();
          } catch (error) {
            await this.post({
              type: "clipboardReadResult",
              requestId: request.requestId,
              success: false,
              text: "",
              contextAttached: false
            });
            throw error;
          }
          let codeReference: ReturnType<typeof clipboardFileReference>;
          const clipboardContext = this.attachments.clipboardReference(text);
          try {
            codeReference = clipboardContext ? clipboardFileReference(clipboardContext) : undefined;
          } catch (error) {
            await this.post({
              type: "clipboardReadResult",
              requestId: request.requestId,
              success: true,
              text: codeReference?.expression ?? text,
              contextAttached: false,
              ...(codeReference ? { codeReference } : {})
            });
            throw error;
          }
          await this.post({
            type: "clipboardReadResult",
            requestId: request.requestId,
            success: true,
            text: codeReference?.expression ?? text,
            contextAttached: false,
            ...(codeReference ? { codeReference } : {})
          });
          break;
        }
        case "dropFiles": {
          const uniqueItems = [...new Map(
            request.items.map((item) => [`${item.kind}:${item.value}`, item])
          ).values()];
          await this.addFileUris(uniqueItems.map((item) => item.kind === "uri"
            ? vscode.Uri.parse(item.value, true)
            : vscode.Uri.file(item.value)));
          break;
        }
        case "chooseFiles": {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            openLabel: "Add to Dext",
            ...(vscode.workspace.workspaceFolders?.[0]
              ? { defaultUri: vscode.workspace.workspaceFolders[0].uri }
              : {})
          });
          if (uris?.length) await this.addFileUris(uris);
          break;
        }
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

  private async run(execute: () => Promise<Awaited<ReturnType<DextApplication["executeInput"]>>>): Promise<void> {
    await this.post({ type: "executing", value: true });
    try {
      await this.post({ type: "execution", response: await execute() });
    } finally {
      await this.post({ type: "executing", value: false });
    }
  }

  private async post(message: WebviewResponse): Promise<void> {
    if (!this.messageQueue.isReady) return;
    await this.view?.webview.postMessage(message);
  }

  private postWhenReady(message: WebviewResponse): void {
    if (this.messageQueue.enqueue(message) || !this.view) return;
    void this.post(message);
  }

  private async flushPendingMessages(messages: readonly WebviewResponse[]): Promise<void> {
    for (const message of messages) await this.post(message);
  }

  private async addFileUris(uris: readonly vscode.Uri[]): Promise<void> {
    const snapshots = await Promise.all(uris.map(async (uri) => fileAttachment(uri)));
    this.postWhenReady({
      type: "insertFileReferences",
      expressions: snapshots.map((snapshot) => attachmentFileReference(snapshot).expression)
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js")
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.css")
    );
    const codicons = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css")
    );
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
    <section id="input-shell" class="input-panel unified-input">
      <div id="code-editor" class="code-editor" aria-label="Dext input"></div>
      <button id="attach-files" class="composer-attach icon-button" type="button" title="Attach workspace files" aria-label="Attach workspace files"><i class="codicon codicon-attach"></i></button>
    </section>

    <div class="action-row">
      <button id="run" class="primary" type="button"><i class="codicon codicon-run"></i><span id="run-label">Send</span></button>
      <button id="problems" class="problems-status" type="button" disabled>No problems</button>
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
