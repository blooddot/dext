import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { DextApplication } from "./application.js";
import type { AgentStreamEvent, UiInteraction } from "./core/types.js";
import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES,
  writeExactClipboardText
} from "./attachmentStore.js";
import {
  attachmentFileReference,
  clipboardFileReference,
  directoryAttachment,
  fileAttachment,
  selectionAttachment
} from "./vscodeAttachments.js";
import { ReadyMessageQueue } from "./readyMessageQueue.js";
import { openWorkspaceFileReference } from "./vscodeContextHost.js";
import { webviewRequestSchema } from "./webviewProtocol.js";
import type { ConversationSummary, WebviewResponse } from "./webviewProtocol.js";
import type { DextHistorySession, DextHistoryStore } from "./historyStore.js";
import { normalizeInputReferenceSource } from "./core/fileReference.js";

function outputSession(): DextHistorySession {
  const now = Date.now();
  return {
    id: randomBytes(12).toString("hex"),
    createdAt: now,
    updatedAt: now,
    turns: []
  };
}

function conversationTitle(session: DextHistorySession): string {
  const first = session.turns[0]?.input.replace(/\s+/g, " ").trim();
  return first ? first.slice(0, 72) : "New conversation";
}

function imageExtension(mimeType: string): string | undefined {
  const normalized = mimeType.toLowerCase().split(";")[0]!.trim();
  return ({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp"
  })[normalized];
}

export class DextSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "dext.sidebar";
  private view: vscode.WebviewView | undefined;
  private readonly messageQueue = new ReadyMessageQueue<WebviewResponse>();
  private readonly attachments = new AttachmentStore();
  private activeSession = outputSession();
  private readonly sessions = new Map<string, DextHistorySession>();
  private sessionsHydrated = false;
  private running = false;
  private activeExecution: { turnId: string; controller: AbortController } | undefined;
  private readonly pendingAttachmentDeletes = new Set<string>();

  private hydrateSessions(): void {
    if (this.sessionsHydrated) return;
    this.sessionsHydrated = true;
    for (const session of this.history.list()) this.sessions.set(session.id, session);
    if (!this.sessions.has(this.activeSession.id)) this.sessions.set(this.activeSession.id, this.activeSession);
    const latest = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (latest) this.activeSession = latest;
  }

  private conversationSummaries(): ConversationSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => ({
        id: session.id,
        title: conversationTitle(session),
        updatedAt: session.updatedAt,
        turnCount: session.turns.length
      }));
  }

  private async postConversationState(): Promise<void> {
    await this.post({
      type: "conversations",
      sessions: this.conversationSummaries(),
      activeId: this.activeSession.id
    });
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly application: DextApplication,
    private readonly history: DextHistoryStore,
    private readonly onViewHistory: () => Promise<void>
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.messageQueue.markNotReady();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
        ...(vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [])
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
    this.activeExecution?.controller.abort();
    this.application.endAgentSession(this.activeSession.id);
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
          this.hydrateSessions();
          await this.refresh();
          await this.postConversationState();
          await this.post({ type: "outputSession", session: this.activeSession });
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
          await this.run(request.mode, request.source);
          break;
        case "stopExecution":
          if (this.activeExecution?.turnId === request.turnId) {
            this.activeExecution.controller.abort();
          }
          break;
        case "viewHistory":
          await this.onViewHistory();
          break;
        case "newConversation":
          if (this.running) throw new Error("Wait for the current Dext turn to finish before starting another conversation.");
          this.application.endAgentSession(this.activeSession.id);
          this.activeSession = outputSession();
          this.sessions.set(this.activeSession.id, this.activeSession);
          await this.postConversationState();
          await this.post({ type: "outputSession", session: this.activeSession });
          break;
        case "selectConversation": {
          if (this.running) throw new Error("Wait for the current Dext turn to finish before switching conversations.");
          const selected = this.sessions.get(request.sessionId);
          if (!selected) throw new Error("Conversation not found.");
          this.application.endAgentSession(this.activeSession.id);
          this.activeSession = selected;
          await this.postConversationState();
          await this.post({ type: "outputSession", session: this.activeSession });
          break;
        }
        case "clearOutput":
          if (this.running) throw new Error("Wait for the current Dext turn to finish before clearing Output.");
          this.application.endAgentSession(this.activeSession.id);
          this.activeSession = outputSession();
          this.sessions.set(this.activeSession.id, this.activeSession);
          await this.postConversationState();
          await this.post({ type: "outputSession", session: this.activeSession });
          break;
        case "agentSelection":
          this.application.setAgentSelection({
            mode: request.selection.mode,
            ...(request.selection.profileId ? { profileId: request.selection.profileId } : {}),
            ...(request.selection.model ? { model: request.selection.model } : {}),
            ...(request.selection.reasoningEffort ? { reasoningEffort: request.selection.reasoningEffort } : {}),
            ...(request.selection.speed ? { speed: request.selection.speed } : {}),
            ...(request.selection.serviceTier ? { serviceTier: request.selection.serviceTier } : {})
          });
          await this.refresh();
          break;
        case "openFileReference":
          await openWorkspaceFileReference(request.reference);
          break;
        case "debugLog":
          appendFileSync(
            join(tmpdir(), "dext-webview-debug.log"),
            `${new Date().toISOString()} ${request.message}\n`,
            "utf8"
          );
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
            // A selection copied from a VS Code editor does not pass through
            // Dext's context-copy command. Recover its workspace reference
            // when the clipboard text still matches the active selection.
            if (!codeReference) {
              const editor = vscode.window.activeTextEditor;
              if (editor && !editor.selection.isEmpty && editor.document.getText(editor.selection) === text) {
                codeReference = attachmentFileReference(await selectionAttachment());
              }
            }
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
            : vscode.Uri.file(item.value)), request.position);
          break;
        }
        case "chooseFiles": {
          const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: true,
            canSelectMany: true,
            openLabel: "Add to Dext",
            ...(vscode.workspace.workspaceFolders?.[0]
              ? { defaultUri: vscode.workspace.workspaceFolders[0].uri }
              : {})
          });
          if (uris?.length) await this.addFileUris(uris);
          break;
        }
        case "pasteImage": {
          const attachment = await this.storeImage(request.data, request.mimeType);
          const view = this.view;
          if (!view) throw new Error("Dext input is not ready.");
          await this.post({
            type: "imageAttachment",
            relativePath: attachment.relativePath,
            webviewUri: view.webview.asWebviewUri(attachment.uri).toString(),
            name: attachment.name
          });
          break;
        }
        case "deleteImageAttachment":
          if (this.running) this.pendingAttachmentDeletes.add(request.relativePath);
          else await this.deleteImage(request.relativePath);
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

  private async run(mode: "agent" | "ask" | "code", source: string): Promise<void> {
    if (this.running) throw new Error("Wait for the current Dext turn to finish before running another one.");
    source = normalizeInputReferenceSource(source);
    const events: AgentStreamEvent[] = [];
    const turnId = randomBytes(12).toString("hex");
    const sessionId = this.activeSession.id;
    const controller = new AbortController();
    this.activeExecution = { turnId, controller };
    this.running = true;
    await this.post({ type: "executing", value: true, turnId, source });
    try {
      const metadata = {
        agentSessionId: sessionId,
        signal: controller.signal,
        ui: this.uiInteraction(),
        onAgentEvent: (event: AgentStreamEvent) => {
          events.push({ ...event });
          this.postAgentEvent(event);
        }
      };
      const response = mode === "code"
        ? await this.application.executeInput(source, metadata)
        : await this.application.executeConversation(mode, source, metadata);
      const turn = await this.history.addSuccess(source, events, response, sessionId);
      this.activeSession.turns.push(turn);
      this.activeSession.updatedAt = turn.createdAt;
      this.sessions.set(this.activeSession.id, this.activeSession);
      await this.postConversationState();
      await this.post({ type: "execution", turnId, response });
    } catch (error) {
      const turn = await this.history.addFailure(source, events, error, sessionId);
      this.activeSession.turns.push(turn);
      this.activeSession.updatedAt = turn.createdAt;
      this.sessions.set(this.activeSession.id, this.activeSession);
      await this.postConversationState();
      await this.post({
        type: "executionFailed",
        turnId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.running = false;
      if (this.activeExecution?.turnId === turnId) this.activeExecution = undefined;
      try {
        await this.flushAttachmentDeletes();
      } finally {
        await this.post({ type: "executing", value: false, turnId });
      }
    }
  }

  private async flushAttachmentDeletes(): Promise<void> {
    const pending = [...this.pendingAttachmentDeletes];
    this.pendingAttachmentDeletes.clear();
    for (const relativePath of pending) await this.deleteImage(relativePath);
  }

  private uiInteraction(): UiInteraction {
    return {
      choose: async ({ label, options, multiple, allowCustom, customPlaceholder }) => {
        const customId = "__dext_custom__";
        const items = [
          ...options.map((option) => ({ label: option, id: option })),
          ...(allowCustom ? [{ label: "Other...", id: customId }] : [])
        ];
        const choices = multiple
          ? await vscode.window.showQuickPick<{ label: string; id: string }>(items, {
            title: label,
            canPickMany: true,
            ignoreFocusOut: true
          }) ?? []
          : await vscode.window.showQuickPick<{ label: string; id: string }>(items, {
            title: label,
            canPickMany: false,
            ignoreFocusOut: true
          }).then((picked) => picked ? [picked] : []);
        if (!choices.some((choice) => choice.id === customId)) {
          return { kind: "ui", type: "choice", selected: choices.map((choice) => choice.id) };
        }
        const custom = await vscode.window.showInputBox({
          title: label,
          prompt: customPlaceholder ?? "Enter a custom option",
          ignoreFocusOut: true
        });
        return {
          kind: "ui",
          type: "choice",
          selected: choices.filter((choice) => choice.id !== customId).map((choice) => choice.id),
          ...(custom?.trim() ? { custom: custom.trim() } : {})
        };
      },
      confirm: async ({ message, confirmLabel, cancelLabel }) => {
        const picked = await vscode.window.showInformationMessage(message, { modal: true }, confirmLabel, cancelLabel);
        return { kind: "ui", type: "confirm", confirmed: picked === confirmLabel };
      },
      input: async ({ label, placeholder, multiline }) => {
        const value = await vscode.window.showInputBox({
          title: label,
          ...(multiline
            ? { prompt: `${placeholder ?? ""} (multiline input is captured as plain text)` }
            : placeholder ? { prompt: placeholder } : {}),
          ignoreFocusOut: true
        });
        return { kind: "ui", type: "input", ...(value !== undefined ? { value } : {}) };
      }
    };
  }

  private postAgentEvent(event: AgentStreamEvent): void {
    this.postWhenReady({ type: "agentEvent", event });
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

  private async addFileUris(uris: readonly vscode.Uri[], position?: number): Promise<void> {
    const references = await Promise.all(uris.map(async (uri) => {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) return directoryAttachment(uri);
      const snapshot = await fileAttachment(uri);
      return attachmentFileReference(snapshot);
    }));
    this.postWhenReady({
      type: "insertFileReferences",
      expressions: references.map((reference) => reference.expression),
      ...(position === undefined ? {} : { position })
    });
  }

  private async storeImage(data: string, mimeType: string): Promise<{ relativePath: string; uri: vscode.Uri; name: string }> {
    const extension = imageExtension(mimeType);
    if (!extension) throw new Error("Unsupported image format. Paste a PNG, JPEG, GIF, WebP, or BMP image.");
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri) throw new Error("Open a workspace before attaching an image.");
    const name = `${randomBytes(12).toString("hex")}${extension}`;
    const buffer = Buffer.from(data, "base64");
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments must be ${MAX_ATTACHMENT_BYTES} bytes or smaller.`);
    }
    const directory = vscode.Uri.joinPath(workspaceUri, ".dext", "attachments");
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, name);
    await vscode.workspace.fs.writeFile(uri, buffer);
    return { relativePath: `.dext/attachments/${name}`, uri, name };
  }

  private async deleteImage(relativePath: string): Promise<void> {
    const normalized = relativePath.replaceAll("\\", "/");
    if (!/^\.dext\/attachments\/[a-f0-9]{24}\.(?:png|jpg|gif|webp|bmp)$/.test(normalized)) return;
    const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceUri) return;
    const uri = vscode.Uri.joinPath(workspaceUri, ...normalized.split("/"));
    try {
      await vscode.workspace.fs.delete(uri);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
    }
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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codicons.toString()}">
  <link rel="stylesheet" href="${style.toString()}">
  <title>Dext</title>
</head>
<body>
  <div class="app-shell">
    <header class="chat-header">
      <div class="conversation-menu">
        <button id="conversation-control" class="conversation-control" type="button" aria-haspopup="menu" aria-expanded="false">
          <span id="conversation-control-value">New conversation</span><i class="codicon codicon-chevron-down"></i>
        </button>
        <div id="conversation-menu" class="conversation-popover" role="menu" hidden></div>
      </div>
      <div class="chat-header-actions">
        <button id="view-methods" class="icon-button" type="button" title="View APIs" aria-label="View APIs" aria-haspopup="dialog" aria-expanded="false"><i class="codicon codicon-symbol-method"></i></button>
        <button id="new-conversation" class="icon-button" type="button" title="New conversation" aria-label="New conversation"><i class="codicon codicon-add"></i></button>
        <button id="view-history" class="icon-button" type="button" title="View Dext history" aria-label="View Dext history"><i class="codicon codicon-history"></i></button>
      </div>
    </header>
    <main id="dext-main">
    <section id="result-section" class="result-section" aria-live="polite">
      <div id="result-heading" class="section-heading collapsible-heading" role="button" tabindex="0" aria-expanded="true">
        <span class="section-heading-label"><i class="section-chevron codicon codicon-chevron-down"></i><span>Output</span></span>
        <div class="section-heading-actions">
          <button id="clear-output" class="icon-button" type="button" title="Clear output" aria-label="Clear output"><i class="codicon codicon-eraser"></i></button>
          <button id="result-fullscreen" class="icon-button panel-fullscreen" type="button" title="Maximize Output" aria-label="Maximize Output"><i class="codicon codicon-screen-full"></i></button>
        </div>
      </div>
      <div id="result-body" class="collapsible-body result-body"><div id="result"></div></div>
    </section>

    <section id="input-section" class="input-section">
      <div id="input-heading" class="section-heading collapsible-heading" role="button" tabindex="0" aria-expanded="true">
        <span class="section-heading-label"><i class="section-chevron codicon codicon-chevron-down"></i><span>Input</span></span>
        <div class="section-heading-actions">
          <button id="input-fullscreen" class="icon-button panel-fullscreen" type="button" title="Maximize Input" aria-label="Maximize Input"><i class="codicon codicon-screen-full"></i></button>
        </div>
      </div>
      <div id="input-body" class="collapsible-body input-body">
        <section id="input-shell" class="input-panel unified-input">
          <div id="code-editor" class="code-editor" aria-label="Dext input"></div>
          <button id="attach-files" class="composer-attach icon-button" type="button" title="Attach workspace files" aria-label="Attach workspace files"><i class="codicon codicon-attach"></i></button>
        </section>

        <div id="input-error" class="input-error" role="alert" hidden></div>

        <div id="attachment-bar" class="attachment-bar hidden" aria-label="Image attachments"></div>

        <div class="action-row">
          <div id="composer-controls" class="composer-controls">
            <div class="composer-menu">
              <button id="mode-control" class="composer-control" type="button" aria-haspopup="menu" aria-expanded="false"><i id="mode-control-icon" class="codicon codicon-comment-discussion" aria-hidden="true"></i><span class="composer-control-label">Mode</span><span id="mode-control-value" class="composer-control-value"></span><i class="codicon codicon-chevron-down"></i></button>
              <div id="mode-menu" class="composer-popover" role="menu" hidden></div>
            </div>
            <div class="composer-menu">
              <button id="agent-control" class="composer-control" type="button" aria-haspopup="menu" aria-expanded="false"><span class="composer-control-label">Agent</span><span id="agent-control-value" class="composer-control-value"></span><i class="codicon codicon-chevron-down"></i></button>
              <div id="agent-menu" class="composer-popover" role="menu" hidden></div>
            </div>
            <div class="composer-menu">
              <button id="model-control" class="composer-control" type="button" aria-haspopup="menu" aria-expanded="false"><span class="composer-control-label">Model</span><span id="model-control-value" class="composer-control-value"></span><i class="codicon codicon-chevron-down"></i></button>
              <div id="model-menu" class="composer-popover composer-model-popover" role="menu" hidden></div>
              <div id="model-submenu" class="composer-popover composer-model-popover composer-model-submenu" role="menu" hidden></div>
            </div>
          </div>
          <div class="action-actions">
            <button id="problems" class="problems-status" type="button" disabled>No problems</button>
            <button id="run" class="primary" type="button"><i class="codicon codicon-run"></i><span id="run-label">Send</span></button>
          </div>
        </div>
      </div>
    </section>

    </main>
    <dialog id="methods-dialog" class="methods-dialog" aria-labelledby="methods-dialog-title">
      <div class="methods-dialog-surface">
        <header class="methods-dialog-header">
          <div class="methods-dialog-title"><i class="codicon codicon-symbol-method"></i><span id="methods-dialog-title">APIs</span><span id="method-count" class="count"></span></div>
          <div class="methods-dialog-actions">
            <button id="methods-toggle" class="icon-button compact" type="button" title="Collapse API namespaces" aria-label="Collapse API namespaces"><i class="codicon codicon-collapse-all"></i></button>
            <button id="close-methods" class="icon-button" type="button" title="Close APIs" aria-label="Close APIs"><i class="codicon codicon-close"></i></button>
          </div>
        </header>
        <div id="methods-dialog-body" class="methods-dialog-body">
          <div id="config-errors" class="config-errors"></div>
          <div id="methods"></div>
        </div>
      </div>
    </dialog>
  </div>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
