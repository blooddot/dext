import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DextApplication } from "./application.js";
import {
  AttachmentStore,
  MAX_ATTACHMENTS,
  writeExactClipboardText
} from "./attachmentStore.js";
import {
  clipboardFileReference,
  fileAttachment,
  selectionAttachment
} from "./vscodeAttachments.js";
import { ReadyMessageQueue } from "./readyMessageQueue.js";
import {
  openWorkspaceDocument,
  openWorkspaceFileReference
} from "./vscodeContextHost.js";
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
    this.postWhenReady({ type: "showChat" });
  }

  async addSelectionToChat(): Promise<void> {
    const attachment = await selectionAttachment();
    this.attachments.add(attachment.view, attachment.reference);
    await this.postAttachments();
    await this.post({ type: "showChat" });
  }

  async copySelectionWithContext(): Promise<string> {
    const attachment = await selectionAttachment();
    const copiedText = await writeExactClipboardText(vscode.env.clipboard, attachment.text);
    this.attachments.stageClipboard(attachment.text, attachment.view, attachment.reference);
    return copiedText;
  }

  async addFileToChat(resource?: vscode.Uri): Promise<void> {
    const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) throw new Error("Choose a workspace file before adding it to Chat.");
    const attachment = await fileAttachment(uri);
    this.attachments.add(attachment.view, attachment.reference);
    await this.postAttachments();
    await this.post({ type: "showChat" });
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
          await this.postAttachments();
          await this.flushPendingMessages(pendingMessages);
          break;
        }
        case "language": {
          const diagnostics = request.source.trim()
            ? this.application.language.diagnostics(request.source)
            : [];
          const signature = this.application.language.signature(request.source, request.cursor);
          const hover = this.application.language.hover(request.source, request.cursor);
          await this.post({
            type: "language",
            requestId: request.requestId,
            completions: this.application.language.completions(request.source, request.cursor),
            diagnostics,
            ...(signature ? { signature } : {}),
            ...(hover ? { hover } : {})
          });
          break;
        }
        case "executeCode":
          await this.run(() => this.application.executeCode(request.source));
          break;
        case "executeChat":
          await this.run(() =>
            this.application.executeChat(request.message, this.attachments.resolve(request.attachmentIds))
          );
          this.attachments.clear(request.attachmentIds);
          await this.postAttachments();
          break;
        case "removeAttachment":
          this.attachments.remove(request.attachmentId);
          await this.postAttachments();
          break;
        case "openAttachment": {
          const attachment = this.attachments.view(request.attachmentId);
          if (!attachment) throw new Error("The attachment is missing or expired.");
          await openWorkspaceDocument(vscode.Uri.parse(attachment.uri, true), attachment.range);
          break;
        }
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
          let contextAttached = false;
          let codeReference: ReturnType<typeof clipboardFileReference>;
          const clipboardContext = this.attachments.clipboardReference(text);
          const contextMatched = clipboardContext !== undefined;
          try {
            if (request.purpose === "chat") {
              contextAttached = contextMatched
                && this.attachments.consumeClipboard(text) !== undefined;
            } else {
              codeReference = clipboardContext ? clipboardFileReference(clipboardContext) : undefined;
            }
          } catch (error) {
            await this.post({
              type: "clipboardReadResult",
              requestId: request.requestId,
              success: true,
              text: contextMatched ? codeReference?.expression ?? "" : text,
              contextAttached: false,
              ...(codeReference ? { codeReference } : {})
            });
            throw error;
          }
          if (contextAttached) await this.postAttachments();
          await this.post({
            type: "clipboardReadResult",
            requestId: request.requestId,
            success: true,
            text: contextMatched ? codeReference?.expression ?? "" : text,
            contextAttached,
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
            openLabel: "Add to Dext Chat",
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

  private async run(execute: () => Promise<Awaited<ReturnType<DextApplication["executeCode"]>>>): Promise<void> {
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

  private async postAttachments(): Promise<void> {
    await this.post({ type: "attachments", attachments: this.attachments.list() });
  }

  private async addFileUris(uris: readonly vscode.Uri[]): Promise<void> {
    if (this.attachments.list().length + uris.length > MAX_ATTACHMENTS) {
      throw new Error(`Chat supports at most ${MAX_ATTACHMENTS} attachments.`);
    }
    const snapshots = await Promise.all(uris.map(async (uri) => fileAttachment(uri)));
    snapshots.forEach((snapshot) => this.attachments.add(snapshot.view, snapshot.reference));
    await this.postAttachments();
    await this.post({ type: "showChat" });
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
    <div class="mode-switch" role="tablist" aria-label="Input mode">
      <button id="code-mode" class="mode active" role="tab" aria-selected="true">Code</button>
      <button id="chat-mode" class="mode" role="tab" aria-selected="false">Chat</button>
    </div>

    <section id="code-panel" class="input-panel">
      <div id="code-editor" class="code-editor" aria-label="Dext method call"></div>
    </section>

    <section id="chat-panel" class="input-panel hidden">
      <div id="chat-composer" class="chat-composer">
        <div id="chat-input" class="chat-input" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Chat message" data-placeholder="Message"></div>
        <button id="attach-files" class="composer-attach icon-button" type="button" title="Attach workspace files" aria-label="Attach workspace files"><i class="codicon codicon-attach"></i></button>
      </div>
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
