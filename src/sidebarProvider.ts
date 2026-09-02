import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import * as vscode from "vscode";
import type { DextApplication } from "./application.js";
import type { AgentStreamEvent, ApplyResult, InputExecutionResponse, McpProcessEvent, PatchResult, UiChoiceResult, UiConfirmResult, UiInputResult, UiInteraction, UiResult } from "./core/types.js";
import { applyPatchHandler } from "./vscodePatchHost.js";
import {
  AttachmentStore,
  writeExactClipboardText
} from "./attachmentStore.js";
import {
  attachmentFileReference,
  activeCodeSelection,
  clipboardFileReference,
  directoryAttachment,
  fileAttachment,
  isCodeDocument,
  selectionAttachment
} from "./vscodeAttachments.js";
import { ReadyMessageQueue } from "./readyMessageQueue.js";
import { rankFileMatches } from "./core/fileSearch.js";
import { planPathSegments } from "./core/planFile.js";
import { openDextFileReference, openExternalLink } from "./vscodeContextHost.js";
import { webviewRequestSchema } from "./webviewProtocol.js";
import type { ConversationSummary, WebviewResponse } from "./webviewProtocol.js";
import type { AgentSelection } from "./agentProfiles.js";
import type { DextHistorySession, DextHistoryStore } from "./historyStore.js";
import type { DextConversationPreferences } from "./conversationPreferences.js";
import { conversationTitle } from "./historyRender.js";
import { normalizeInputReferenceSource } from "./core/fileReference.js";
import type { McpServerConfig } from "./core/mcpRegistry.js";

/** An `agent(apply=False)` step proposes changes and writes nothing, so its
 * patch is the one Dext holds for review. A step that was allowed to write has
 * already landed and must not be offered again. */
function unappliedPatch(response: InputExecutionResponse): PatchResult | undefined {
  const changes: PatchResult["changes"] = [];
  let title = "Proposed changes";
  for (const execution of response.executions) {
    if (execution.result.kind !== "agent" || !execution.result.patch) continue;
    const applied = execution.invocation.arguments
      .some((argument) => argument.name === "apply" && argument.value !== false);
    if (applied) continue;
    title = execution.result.patch.title || title;
    changes.push(...execution.result.patch.changes.filter((change) => change.before !== change.after));
  }
  if (!changes.length) return undefined;
  return { kind: "patch", title, changes };
}

function outputSession(): DextHistorySession {
  const now = Date.now();
  return {
    id: randomBytes(12).toString("hex"),
    createdAt: now,
    updatedAt: now,
    turns: []
  };
}

// A conversation that has never had its composer controls changed must start
// from the product defaults. In particular, do not copy the profile store's
// global last-used selection here: that would make a Code selection bleed into
// every newly opened tab.
function defaultConversationSelection(): AgentSelection {
  return { mode: "agent" };
}

// The picker ranks paths in the host, so the index has to be broad enough to
// contain the answer while staying cheap enough to rebuild on a stale read.
const MAX_INDEXED_FILES = 20000;
const MAX_FILE_SUGGESTIONS = 40;
const FILE_INDEX_TTL_MS = 15000;
const FILE_INDEX_EXCLUDE = "**/{node_modules,.git,dist,out,build,.venv,__pycache__,.dext/attachments}/**";

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
  // Only the composer mode belongs to a conversation tab. Permission, CLI,
  // model, and model parameters are global profile preferences.
  private readonly conversationSelections = new Map<string, AgentSelection>();
  // Conversations behave like editor tabs: the strip only shows the ones that
  // are open, while every conversation stays reachable through history.
  private openConversations: string[] = [this.activeSession.id];
  private sessionsHydrated = false;
  private readonly activeExecutions = new Map<string, {
    turnId: string;
    source: string;
    planPath?: string;
    executePlan?: boolean;
    controller: AbortController;
    events: AgentStreamEvent[];
  }>();
  // MCP manifest generation is an Agent-backed operation too, but it is not a
  // conversation turn and therefore does not belong in activeExecutions.
  // Keeping its controller separately lets the shared Stop button cancel it.
  private mcpAssistantExecution: { requestId: string; controller: AbortController } | undefined;
  private readonly pendingAttachmentDeletes = new Set<string>();
  // A read-only Agent turn leaves a patch nobody applied yet. It is kept per
  // turn so two turns in the same conversation cannot resolve each other's
  // files, and so a rejected file simply disappears from the entry.
  private readonly pendingPatches = new Map<string, PatchResult>();
  private readonly pendingUi = new Map<string, {
    resolve: (result: UiResult) => void;
    reject: (error: Error) => void;
  }>();
  private fileIndex: { paths: string[]; loadedAt: number } | undefined;

  private hydrateSessions(): void {
    if (this.sessionsHydrated) return;
    this.sessionsHydrated = true;
    for (const session of this.history.list()) this.sessions.set(session.id, session);
    if (!this.sessions.has(this.activeSession.id)) this.sessions.set(this.activeSession.id, this.activeSession);
    const latest = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const layout = this.preferences.conversationLayout();
    const restored = layout.openConversationIds.filter((id) => this.sessions.has(id));
    const previouslyActive = layout.activeConversationId
      ? this.sessions.get(layout.activeConversationId)
      : undefined;
    if (previouslyActive) this.activeSession = previouslyActive;
    else if (latest) this.activeSession = latest;
    this.conversationSelections.set(this.activeSession.id, {
      mode: this.application.state().agentSelection.mode ?? "agent"
    });
    // Keep every tab the user left open, including non-pinned ones. Pins still
    // provide a backwards-compatible fallback for layouts saved before this
    // state was introduced.
    const pinned = this.preferences.pinned().filter((id) => this.sessions.has(id));
    this.openConversations = [...new Set([...restored, ...pinned, this.activeSession.id])];
  }

  private async persistConversationLayout(): Promise<void> {
    await this.preferences.setConversationLayout({
      openConversationIds: this.openConversations,
      activeConversationId: this.activeSession.id
    });
  }

  // Pinned tabs lead the strip so that they keep their place as other
  // conversations open and close beside them.
  private orderedConversations(): string[] {
    const pinned = this.preferences.pinned().filter((id) => this.openConversations.includes(id));
    return [...pinned, ...this.openConversations.filter((id) => !pinned.includes(id))];
  }

  private summarize(session: DextHistorySession): ConversationSummary {
    return {
      id: session.id,
      title: this.preferences.title(session.id) ?? conversationTitle(session),
      updatedAt: session.updatedAt,
      turnCount: session.turns.length,
      pinned: this.preferences.isPinned(session.id),
      running: this.activeExecutions.has(session.id)
    };
  }

  private async postConversationState(): Promise<void> {
    await this.post({
      type: "conversations",
      sessions: this.orderedConversations().flatMap((id) => {
        const session = this.sessions.get(id);
        return session ? [this.summarize(session)] : [];
      }),
      activeId: this.activeSession.id
    });
  }

  private async activateConversation(session: DextHistorySession): Promise<void> {
    this.activeSession = session;
    const mode = this.conversationSelections.get(session.id)?.mode ?? "agent";
    this.conversationSelections.set(session.id, { mode });
    this.application.setAgentSelection({ ...this.application.state().agentSelection, mode });
    if (!this.openConversations.includes(session.id)) this.openConversations.push(session.id);
    await this.persistConversationLayout();
    this.updateRunningContext();
    await this.postConversationState();
    await this.refresh();
    await this.post({ type: "outputSession", session: this.activeSession });
    await this.postActiveExecution(session.id);
  }

  // A new conversation opens its own tab, while clearing replaces the
  // conversation shown in the tab that is already active.
  private async startConversation(replaceActiveTab = false): Promise<void> {
    const index = replaceActiveTab ? this.openConversations.indexOf(this.activeSession.id) : -1;
    if (replaceActiveTab) this.application.endAgentSession(this.activeSession.id);
    this.activeSession = outputSession();
    this.sessions.set(this.activeSession.id, this.activeSession);
    this.conversationSelections.set(this.activeSession.id, defaultConversationSelection());
    this.application.setAgentSelection({ ...this.application.state().agentSelection, mode: "agent" });
    if (index === -1) this.openConversations.push(this.activeSession.id);
    else this.openConversations[index] = this.activeSession.id;
    await this.persistConversationLayout();
    this.updateRunningContext();
    await this.postConversationState();
    await this.refresh();
    await this.post({ type: "outputSession", session: this.activeSession });
  }

  // Closing a tab only hides the conversation; history keeps it so that the
  // conversation list can reopen it later.
  private async closeConversation(sessionId: string): Promise<void> {
    const visible = this.orderedConversations();
    const index = visible.indexOf(sessionId);
    if (index === -1) return;
    if (this.activeExecutions.has(sessionId)) {
      throw new Error("Stop this Dext turn before closing its conversation.");
    }
    this.application.endAgentSession(sessionId);
    this.openConversations = this.openConversations.filter((id) => id !== sessionId);
    // Closing is an explicit dismissal, so a pinned conversation must not come
    // back on the next reload.
    if (this.preferences.isPinned(sessionId)) await this.preferences.setPinned(sessionId, false);
    if (sessionId !== this.activeSession.id) {
      await this.persistConversationLayout();
      await this.postConversationState();
      return;
    }
    const remaining = visible.filter((id) => id !== sessionId);
    const neighbour = remaining[index] ?? remaining[index - 1];
    const session = neighbour ? this.sessions.get(neighbour) : undefined;
    if (!session) {
      await this.startConversation();
      return;
    }
    this.activeSession = session;
    const mode = this.conversationSelections.get(session.id)?.mode ?? "agent";
    this.conversationSelections.set(session.id, { mode });
    this.application.setAgentSelection({ ...this.application.state().agentSelection, mode });
    await this.persistConversationLayout();
    this.updateRunningContext();
    await this.postConversationState();
    await this.refresh();
    await this.post({ type: "outputSession", session: this.activeSession });
    await this.postActiveExecution(session.id);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly application: DextApplication,
    private readonly history: DextHistoryStore,
    private readonly preferences: DextConversationPreferences
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.messageQueue.markNotReady();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
        this.application.storage.globalStorageUri,
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
    await this.postPlanContext();
  }

  private async postPlanContext(): Promise<void> {
    await this.post({ type: "planContext", ...(this.activeSession.activePlanPath ? { path: this.activeSession.activePlanPath } : {}), status: this.activeSession.planStatus ?? "new" });
  }

  async setActivePlan(reference: string | undefined): Promise<void> {
    this.hydrateSessions();
    if (this.activeExecutions.has(this.activeSession.id)) throw new Error("Stop the running turn before changing the active plan.");
    if (reference) {
      const uri = this.application.planUri(reference);
      if (!uri) throw new Error(`'${reference}' is not a Dext plan file.`);
      this.activeSession.activePlanPath = reference;
      this.activeSession.planStatus = "active";
    } else {
      delete this.activeSession.activePlanPath;
      this.activeSession.planStatus = "new";
    }
    await this.history.updatePlanContext(this.activeSession.id, this.activeSession.activePlanPath, this.activeSession.planStatus);
    await this.postPlanContext();
  }

  async setActivePlanFromUri(uri: vscode.Uri): Promise<void> {
    const globalRoot = this.application.storage.globalStorageUri.fsPath;
    const folder = vscode.workspace.workspaceFolders?.[0];
    let reference: string | undefined;
    const globalRelative = relative(globalRoot, uri.fsPath);
    if (globalRelative && !globalRelative.startsWith(`..${sep}`) && globalRelative !== "..") {
      const segments = globalRelative.split(/[\\/]+/).filter(Boolean);
      if (segments[0] === "plans" && segments.length > 1) reference = [".dext-global", ...segments].join("/");
    }
    if (!reference && folder) {
      const workspaceRelative = relative(folder.uri.fsPath, uri.fsPath);
      if (workspaceRelative && !workspaceRelative.startsWith(`..${sep}`) && workspaceRelative !== "..") {
        const normalized = workspaceRelative.replaceAll("\\", "/");
        if (normalized.startsWith(".dext/plans/")) reference = normalized;
      }
    }
    if (!reference || !reference.endsWith(".plan.md")) throw new Error("The active editor is not a Dext plan file.");
    await this.setActivePlan(reference);
  }

  private async choosePlan(): Promise<void> {
    this.hydrateSessions();
    const items: Array<vscode.QuickPickItem & { reference?: string }> = [{ label: "$(add) New plan", description: "Create a new plan document" }];
    const roots: Array<{ uri: vscode.Uri; prefix: string }> = [{ uri: vscode.Uri.joinPath(this.application.storage.globalStorageUri, "plans"), prefix: ".dext-global/plans" }];
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) roots.push({ uri: vscode.Uri.joinPath(folder.uri, ".dext", "plans"), prefix: ".dext/plans" });
    for (const root of roots) {
      try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(root.uri)) {
          if (type === vscode.FileType.File && name.endsWith(".plan.md")) items.push({ label: name, description: root.prefix, reference: `${root.prefix}/${name}` });
        }
      } catch { /* A plan directory may not exist yet. */ }
    }
    const picked = await vscode.window.showQuickPick(items, { title: "Select a Dext plan", placeHolder: "Choose a plan to edit or start a new one" });
    if (!picked) return;
    await this.setActivePlan(picked.reference);
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

  viewApis(): void {
    this.postWhenReady({ type: "openMethods" });
  }

  viewMcp(): void {
    this.postWhenReady({ type: "openMcp" });
  }

  addMcp(): void {
    this.postWhenReady({ type: "mcpAssistant" });
  }

  async newConversation(): Promise<void> {
    this.hydrateSessions();
    await this.startConversation();
  }

  // History hands over its own copy of a conversation; an already open one
  // keeps the in-memory instance so that a running turn stays attached to it.
  async openConversation(session: DextHistorySession): Promise<void> {
    this.hydrateSessions();
    const existing = this.sessions.get(session.id) ?? session;
    this.sessions.set(existing.id, existing);
    await this.activateConversation(existing);
  }

  // Renaming only replaces the label a conversation is listed under. The agent
  // runners key their CLI and AIOA sessions on the conversation id, which the
  // rename never touches, so a renamed conversation keeps answering in the same
  // agent session it always did.
  async renameConversation(sessionId: string, title: string): Promise<void> {
    await this.preferences.setTitle(sessionId, title);
    await this.postConversationState();
  }

  async pinConversation(sessionId: string, pinned: boolean): Promise<void> {
    this.hydrateSessions();
    await this.preferences.setPinned(sessionId, pinned);
    await this.persistConversationLayout();
    await this.postConversationState();
  }

  async closeTab(sessionId: string): Promise<void> {
    this.hydrateSessions();
    await this.closeConversation(sessionId);
  }

  async deleteTurn(turnId: string): Promise<void> {
    if (this.activeExecutions.has(this.activeSession.id)) {
      throw new Error("Stop this Dext turn before deleting a conversation turn.");
    }
    this.hydrateSessions();
    const index = this.activeSession.turns.findIndex((turn) => turn.id === turnId);
    if (index === -1) throw new Error("Conversation turn not found.");
    const confirmed = await vscode.window.showWarningMessage(
      "Delete this conversation turn?",
      { modal: true },
      "Delete"
    );
    if (confirmed !== "Delete") return;
    const removed = await this.history.removeTurn(this.activeSession.id, turnId);
    if (!removed) throw new Error("Conversation turn not found.");
    this.activeSession.turns.splice(index, 1);
    this.activeSession.updatedAt = this.activeSession.turns.at(-1)?.createdAt ?? this.activeSession.createdAt;
    if (this.activeSession.turns.length) this.activeSession.createdAt = this.activeSession.turns[0]!.createdAt;
    this.pendingPatches.delete(turnId);
    await this.postConversationState();
    await this.post({ type: "outputSession", session: this.activeSession });
  }

  async forgetConversation(sessionId: string): Promise<void> {
    if (this.activeExecutions.has(sessionId)) {
      throw new Error("Stop this Dext turn before deleting its conversation.");
    }
    this.hydrateSessions();
    this.sessions.delete(sessionId);
    this.conversationSelections.delete(sessionId);
    if (this.openConversations.includes(sessionId)) {
      await this.closeConversation(sessionId);
      return;
    }
    if (sessionId === this.activeSession.id) await this.startConversation();
    else await this.persistConversationLayout();
  }

  setInput(source: string): void {
    this.postWhenReady({ type: "setInput", source });
  }

  /** The keyboard and Command Palette route into the same abort the composer's
   * Stop button uses, so there is only one way a turn ends early. */
  stopExecution(): void {
    const execution = this.activeExecutions.get(this.activeSession.id);
    if (execution) {
      execution.controller.abort();
      return;
    }
    if (this.mcpAssistantExecution) {
      this.mcpAssistantExecution.controller.abort();
      return;
    }
    throw new Error("No Dext turn is running in this conversation.");
  }

  async addSelectionToChat(): Promise<void> {
    const attachment = await selectionAttachment();
    this.postWhenReady({
      type: "insertFileReferences",
      expressions: [attachmentFileReference(attachment).expression]
    });
  }

  async copySelectionWithContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    const attachment = await selectionAttachment();
    const copiedText = await writeExactClipboardText(vscode.env.clipboard, attachment.text);
    const reference = editor
      && isCodeDocument(editor.document)
      && vscode.workspace.getWorkspaceFolder(editor.document.uri)
      ? clipboardFileReference(attachment.reference)
      : undefined;
    if (reference) {
      this.attachments.stageClipboard(attachment.text, reference);
    } else {
      this.attachments.clearClipboard();
    }
    return copiedText;
  }

  /** Terminal text has no VS Code document URI. Save a bounded snapshot as a
   * Dext-owned log and stage its @attachment token for the next ordinary paste. */
  async copyTerminalSelectionWithContext(): Promise<void> {
    await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
    const text = await vscode.env.clipboard.readText();
    if (!text) throw new Error("Select terminal output before copying it with context.");
    const attachment = await this.storeTerminalOutput(text);
    this.attachments.stageClipboard(text, {
      payload: attachment.relativePath,
      expression: `@${attachment.relativePath}`
    });
  }

  async addFileToChat(resource?: vscode.Uri): Promise<void> {
    const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) throw new Error("Choose a workspace file or directory before adding it to Dext input.");
    await this.addFileUris([uri]);
  }

  dispose(): void {
    for (const [sessionId, execution] of this.activeExecutions) {
      execution.controller.abort();
      this.application.endAgentSession(sessionId);
    }
    this.mcpAssistantExecution?.controller.abort();
    this.mcpAssistantExecution = undefined;
    this.attachments.dispose();
    for (const pending of this.pendingUi.values()) pending.reject(new Error("Dext UI interaction was closed."));
    this.pendingUi.clear();
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
          this.updateRunningContext();
          await this.refresh();
          await this.postConversationState();
          await this.post({ type: "outputSession", session: this.activeSession });
          await this.postActiveExecution(this.activeSession.id);
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
          await this.run(request.mode, request.source, request.planPath);
          break;
        case "uiResponse": {
          const pending = this.pendingUi.get(request.requestId);
          if (!pending) break;
          this.pendingUi.delete(request.requestId);
          const response = request.response;
          if (response.type === "choice") {
            pending.resolve({ kind: "ui", type: "choice", selected: response.selected, ...(response.custom?.trim() ? { custom: response.custom.trim() } : {}) } satisfies UiChoiceResult);
          } else if (response.type === "confirm") {
            pending.resolve({ kind: "ui", type: "confirm", confirmed: response.confirmed } satisfies UiConfirmResult);
          } else {
            pending.resolve({ kind: "ui", type: "input", ...(response.value !== undefined ? { value: response.value } : {}) } satisfies UiInputResult);
          }
          break;
        }
        case "stopExecution":
          for (const execution of this.activeExecutions.values()) {
            if (execution.turnId === request.turnId) execution.controller.abort();
          }
          if (this.mcpAssistantExecution?.requestId === request.turnId) {
            this.mcpAssistantExecution.controller.abort();
          }
          break;
        case "retryTurn": {
          const turn = this.activeSession.turns.find((item) => item.id === request.turnId);
          if (!turn) throw new Error("Conversation turn not found.");
          // Turns recorded before Dext tracked the mode fall back to the one
          // the composer is showing, which is what the user sees on screen.
          await this.run(turn.mode ?? this.application.state().agentSelection.mode ?? "agent", turn.input);
          break;
        }
        case "deleteTurn":
          await this.deleteTurn(request.turnId);
          break;
        case "buildPlan":
          await this.buildPlan(request.planPath);
          break;
        case "choosePlan":
          await this.choosePlan();
          break;
        case "resolvePatch":
          await this.resolvePatch(request.turnId, request.uris, request.accept);
          break;
        case "newConversation":
          await this.newConversation();
          break;
        case "selectConversation": {
          const selected = this.sessions.get(request.sessionId);
          if (!selected) throw new Error("Conversation not found.");
          await this.activateConversation(selected);
          break;
        }
        case "closeConversation":
          await this.closeConversation(request.sessionId);
          break;
        case "pinConversation":
          await this.pinConversation(request.sessionId, request.pinned);
          break;
        case "agentSelection":
          {
          const selection = {
            ...this.application.state().agentSelection,
            permission: request.selection.permission,
            ...(request.selection.profileId ? { profileId: request.selection.profileId } : {}),
            ...(request.selection.model ? { model: request.selection.model } : {}),
            ...(request.selection.reasoningEffort ? { reasoningEffort: request.selection.reasoningEffort } : {}),
            ...(request.selection.speed ? { speed: request.selection.speed } : {}),
            ...(request.selection.serviceTier ? { serviceTier: request.selection.serviceTier } : {})
          } satisfies AgentSelection;
          this.conversationSelections.set(this.activeSession.id, { mode: request.selection.mode });
          this.application.setAgentSelection({ ...selection, mode: request.selection.mode });
          this.updateRunningContext();
          await this.refresh();
          break;
          }
        case "openFileReference":
          await openDextFileReference(request.reference, this.application.storage);
          break;
        case "openExternalLink":
          await openExternalLink(request.url);
          break;
        case "searchFiles":
          await this.post({
            type: "searchFilesResult",
            requestId: request.requestId,
            files: rankFileMatches(
              await this.workspaceFileIndex(),
              request.query,
              MAX_FILE_SUGGESTIONS
            )
          });
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
          let codeReference: ReturnType<typeof this.attachments.clipboardReference> = undefined;
          try {
            if (request.purpose === "code") {
              const editor = vscode.window.activeTextEditor;
              const hasMatchingSelection = Boolean(
                editor
                && !editor.selection.isEmpty
                && editor.document.getText(editor.selection) === text
              );

              // A selection copied from a VS Code editor does not pass through
              // Dext's context-copy command. Recover its workspace reference
              // when the clipboard text still matches the active selection.
              // When that selection is outside the workspace (or is prose),
              // deliberately leave the text untouched. In particular, do not
              // fall back to a stale staged reference from an earlier project
              // selection with identical contents.
              if (hasMatchingSelection) {
                const current = activeCodeSelection();
                if (current) {
                  const attachment = await selectionAttachment();
                  codeReference = clipboardFileReference(attachment.reference);
                } else {
                  // The matching selection is known to be non-project or
                  // non-code. Drop any older staged context as well, so a
                  // second paste after focus changes cannot resurrect a ref
                  // for this external/prose content.
                  this.attachments.clearClipboard();
                }
              } else {
                // Explicit context-copy commands (including terminal output)
                // have no active editor selection to validate against, so the
                // short-lived staged reference remains available here.
                codeReference = this.attachments.clipboardReference(text);
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
          if (this.activeExecutions.size) this.pendingAttachmentDeletes.add(request.relativePath);
          else await this.deleteImage(request.relativePath);
          break;
        case "reload":
          await this.application.reload();
          await this.refresh();
          break;
        case "openMcp":
          await this.post({ type: "openMcp" });
          break;
        case "addMcp":
          // Keep the entire add flow in the conversation webview so the user
          // gets a multiline, chat-like composer instead of an editor-level
          // one-line input box.
          await this.post({ type: "mcpAssistant" });
          break;
        case "generateMcp": {
          // Stream the selected Agent's process into the MCP dialog. A
          // notification progress item is intentionally not used here: it
          // hides the useful context in the bottom-right corner.
          if (this.mcpAssistantExecution) throw new Error("MCP generation is already running.");
          const controller = new AbortController();
          this.mcpAssistantExecution = { requestId: request.requestId, controller };
          this.updateRunningContext();
          await this.post({
            type: "executing",
            sessionId: this.activeSession.id,
            value: true,
            turnId: request.requestId,
            source: "Add MCP with AI"
          });
          try {
            const server = await this.application.generateMcpManifest(request.document, {
              signal: controller.signal,
              onAgentEvent: (event) => this.postWhenReady({ type: "mcpProgress", requestId: request.requestId, event })
            });
            await this.post({ type: "mcpGenerated", requestId: request.requestId, server });
            // Discover tools as soon as the draft arrives so the review step
            // can show an explicit allowlist before the user saves anything.
            try {
              const tools = await this.application.discoverMcpTools(server);
              await this.post({ type: "mcpToolsDiscovered", requestId: request.requestId, tools });
            } catch {
              // A draft remains editable/savable when discovery needs auth or
              // the endpoint is temporarily unavailable.
              await this.post({ type: "mcpToolsDiscovered", requestId: request.requestId, tools: [] });
            }
          } finally {
            if (this.mcpAssistantExecution?.requestId === request.requestId) {
              this.mcpAssistantExecution = undefined;
            }
            this.updateRunningContext();
            await this.post({ type: "executing", sessionId: this.activeSession.id, value: false, turnId: request.requestId });
          }
          break;
        }
        case "prepareMcp": {
          const server: McpServerConfig = request.server.transport === "stdio"
            ? { name: request.server.name, transport: "stdio", command: request.server.command, scope: request.scope ?? "project", ...(request.server.args ? { args: request.server.args } : {}), ...(request.server.auth ? { auth: request.server.auth } : {}), ...(request.server.timeoutMs !== undefined ? { timeoutMs: request.server.timeoutMs } : {}) }
            : { name: request.server.name, transport: "http", url: request.server.url, scope: request.scope ?? "project", ...(request.server.auth ? { auth: request.server.auth } : {}), ...(request.server.timeoutMs !== undefined ? { timeoutMs: request.server.timeoutMs } : {}) };
          const tools = await this.application.discoverMcpTools(server);
          await this.post({ type: "mcpToolsDiscovered", requestId: request.requestId, tools });
          break;
        }
        case "createMcp": {
          // Zod's optional fields are typed as `T | undefined`; normalize them
          // at the host boundary so exactOptionalPropertyTypes remains sound.
          const server: McpServerConfig = request.server.transport === "stdio"
            ? {
              name: request.server.name,
              transport: "stdio",
              command: request.server.command,
              ...(request.server.args ? { args: request.server.args } : {}),
              ...(request.server.auth ? { auth: request.server.auth } : {}),
              ...(request.server.timeoutMs !== undefined ? { timeoutMs: request.server.timeoutMs } : {})
            }
            : {
              name: request.server.name,
              transport: "http",
              url: request.server.url,
              ...(request.server.auth ? { auth: request.server.auth } : {}),
              ...(request.server.timeoutMs !== undefined ? { timeoutMs: request.server.timeoutMs } : {})
            };
          await this.application.createMcpManifest(server, request.scope ?? "project", request.selectedTools);
          await this.refresh();
          await this.post({ type: "mcpCreated", name: server.name });
          break;
        }
      }
    } catch (error) {
      await this.post({
        type: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Accepting is what actually writes a read-only Agent turn to disk. Files are
   * resolved one entry at a time so accepting part of a proposal leaves the rest
   * pending instead of discarding it. */
  private async resolvePatch(turnId: string, uris: readonly string[], accept: boolean): Promise<void> {
    const sessionId = this.activeSession.id;
    const pending = this.pendingPatches.get(turnId);
    if (!pending) throw new Error("These changes are no longer available for review.");
    const targets = uris.length
      ? pending.changes.filter((change) => uris.includes(change.uri))
      : [...pending.changes];
    if (!targets.length) throw new Error("None of those files are part of this proposal.");
    const resolved = targets.map((change) => change.uri);
    const remaining = pending.changes.filter((change) => !resolved.includes(change.uri));
    if (!accept) {
      this.forgetResolvedChanges(turnId, pending, remaining);
      await this.post({
        type: "patchResolved",
        sessionId,
        turnId,
        uris: resolved,
        status: "rejected",
        message: `Discarded ${resolved.length} proposed change${resolved.length === 1 ? "" : "s"}.`
      });
      return;
    }
    const patch: PatchResult = { kind: "patch", title: pending.title, changes: targets };
    const result = await applyPatchHandler({
      invocation: { kind: "invocation", method: "apply", arguments: [], source: "chat" },
      method: this.applyMethod(),
      arguments: { result: patch },
      context: [],
      metadata: {}
    }) as ApplyResult;
    // A conflict leaves the entry pending: the file moved on, and re-reviewing
    // it is the only honest next step.
    if (result.status === "applied" || result.status === "unchanged") {
      this.forgetResolvedChanges(turnId, pending, remaining);
    }
    await this.post({
      type: "patchResolved",
      sessionId,
      turnId,
      uris: resolved,
      status: result.status === "applied" || result.status === "unchanged" ? result.status : "conflict",
      message: result.summary
    });
  }

  private forgetResolvedChanges(turnId: string, pending: PatchResult, remaining: PatchResult["changes"]): void {
    if (remaining.length) this.pendingPatches.set(turnId, { ...pending, changes: remaining });
    else this.pendingPatches.delete(turnId);
  }

  private applyMethod(): Parameters<typeof applyPatchHandler>[0]["method"] {
    const method = this.application.registry.get("apply");
    if (!method) throw new Error("The apply API is not available.");
    return method;
  }

  /** Handing a plan to the Agent re-reads the file rather than trusting the
   * text from the turn, so edits the user made in the editor are what gets
   * built. The path comes from the webview, so it is checked before any read. */
  private async buildPlan(planPath: string): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !this.application.isTrustedLocalWorkspace()) {
      throw new Error("Building a plan requires a trusted local workspace.");
    }
    const target = this.application.planUri(planPath)
      ?? vscode.Uri.joinPath(folder.uri, ...planPathSegments(planPath));
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
    } catch {
      throw new Error(`Plan '${planPath}' is no longer available.`);
    }
    if (!text.trim()) throw new Error(`Plan '${planPath}' is empty.`);
    this.activeSession.activePlanPath = planPath;
    this.activeSession.planStatus = "running";
    await this.history.updatePlanContext(this.activeSession.id, planPath, "running");
    await this.refresh();
    await this.run("plan", [
      `Implement the plan in ${planPath} exactly as written. Do not edit the plan file itself.`,
      "",
      text.trim()
    ].join("\n"), undefined, true);
  }

  private async run(mode: "agent" | "ask" | "plan" | "code", source: string, planPath?: string, executePlan = false): Promise<void> {
    source = normalizeInputReferenceSource(source);
    const events: AgentStreamEvent[] = [];
    const turnId = randomBytes(12).toString("hex");
    const session = this.activeSession;
    const sessionId = session.id;
    const executionPlanPath = executePlan ? planPath ?? session.activePlanPath : planPath;
    if (this.activeExecutions.has(sessionId)) {
      throw new Error("Wait for this conversation's current Dext turn to finish before running another one.");
    }
    const controller = new AbortController();
    this.activeExecutions.set(sessionId, { turnId, source, ...(executionPlanPath ? { planPath: executionPlanPath } : {}), ...(executePlan ? { executePlan: true } : {}), controller, events });
    this.updateRunningContext();
    await this.postConversationState();
    await this.post({ type: "executing", sessionId, value: true, turnId, source, ...(executionPlanPath ? { planPath: executionPlanPath } : {}), ...(executePlan ? { executePlan: true } : {}) });
    try {
      const metadata = {
        agentSessionId: sessionId,
        signal: controller.signal,
        ui: this.uiInteraction(),
        ...(mode === "plan" && executionPlanPath ? { planPath: executionPlanPath } : {}),
        ...(executePlan ? { executePlan: true } : {}),
        onAgentEvent: (event: AgentStreamEvent) => {
          events.push({ ...event });
          this.postAgentEvent(sessionId, event);
        },
        onMcpEvent: (event: McpProcessEvent) => {
          const processEvent: AgentStreamEvent = {
            phase: "tool",
            toolKind: "step",
            solo: true,
            title: `MCP ${event.source}`,
            text: event.text
          };
          events.push(processEvent);
          this.postAgentEvent(sessionId, processEvent);
        }
      };
      const response = mode === "code"
        ? await this.application.executeInput(source, metadata)
        : await this.application.executeConversation(mode, source, metadata);
      const turn = await this.history.addSuccess(source, events, response, sessionId, mode);
      if (mode === "plan" && response.executions.some((execution) => execution.result.kind === "chat" && execution.result.planPath)) {
        const savedPath = response.executions.find((execution) => execution.result.kind === "chat" && execution.result.planPath)?.result;
        if (savedPath?.kind === "chat" && savedPath.planPath) {
          session.activePlanPath = savedPath.planPath;
          session.planStatus = "active";
          await this.history.updatePlanContext(sessionId, savedPath.planPath, "active");
          await this.postPlanContext();
        }
      }
      session.turns.push(turn);
      session.updatedAt = turn.createdAt;
      this.sessions.set(sessionId, session);
      await this.postConversationState();
      const reviewable = unappliedPatch(response);
      if (reviewable) this.pendingPatches.set(turnId, reviewable);
      await this.post({
        type: "execution",
        sessionId,
        turnId,
        response,
        ...(reviewable ? { reviewPatch: true } : {})
      });
    } catch (error) {
      if (mode === "plan" && session.planStatus === "running") {
        session.planStatus = "failed";
        await this.history.updatePlanContext(sessionId, session.activePlanPath, "failed");
        await this.postPlanContext();
      }
      const turn = await this.history.addFailure(source, events, error, sessionId, mode);
      session.turns.push(turn);
      session.updatedAt = turn.createdAt;
      this.sessions.set(sessionId, session);
      await this.postConversationState();
      await this.post({
        type: "executionFailed",
        sessionId,
        turnId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      const active = this.activeExecutions.get(sessionId);
      if (active?.turnId === turnId) this.activeExecutions.delete(sessionId);
      if (mode === "plan" && session.planStatus === "running") {
        session.planStatus = "completed";
        await this.history.updatePlanContext(sessionId, session.activePlanPath, "completed");
        await this.postPlanContext();
      }
      this.updateRunningContext();
      await this.postConversationState();
      try {
        if (!this.activeExecutions.size) await this.flushAttachmentDeletes();
      } finally {
        await this.post({ type: "executing", sessionId, value: false, turnId });
      }
    }
  }

  // Ranking happens over a cached listing rather than one glob per keystroke,
  // because a glob cannot express a fuzzy match that crosses path separators.
  private async workspaceFileIndex(): Promise<readonly string[]> {
    const now = Date.now();
    if (this.fileIndex && now - this.fileIndex.loadedAt < FILE_INDEX_TTL_MS) return this.fileIndex.paths;
    let paths: string[];
    try {
      const uris = await vscode.workspace.findFiles("**/*", FILE_INDEX_EXCLUDE, MAX_INDEXED_FILES);
      paths = uris.flatMap((uri) => {
        const relative = vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
        // A file outside every workspace folder has no reference Dext can build.
        return relative.startsWith("..") || relative.includes(":") ? [] : [relative];
      });
    } catch {
      // A failed listing must leave the composer usable, not raise an error
      // banner over a keystroke the user did not think of as a command.
      paths = [];
    }
    this.fileIndex = { paths, loadedAt: now };
    return paths;
  }

  // The stop keybinding is only live while a turn is running, which keeps a
  // convenient chord from shadowing anything the rest of the time.
  private updateRunningContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "dext.running",
      this.activeExecutions.has(this.activeSession.id) || Boolean(this.mcpAssistantExecution)
    );
    void vscode.commands.executeCommand(
      "setContext",
      "dext.planMode",
      (this.conversationSelections.get(this.activeSession.id)?.mode
        ?? this.application.state().agentSelection.mode
        ?? "agent") === "plan"
    );
  }

  private async flushAttachmentDeletes(): Promise<void> {
    const pending = [...this.pendingAttachmentDeletes];
    this.pendingAttachmentDeletes.clear();
    for (const relativePath of pending) await this.deleteImage(relativePath);
  }

  private uiInteraction(): UiInteraction {
    const request = <T extends UiResult>(interaction: NonNullable<Extract<WebviewResponse, { type: "uiRequest" }>["request"]>): Promise<T> => {
      const requestId = randomBytes(12).toString("hex");
      return new Promise<T>((resolve, reject) => {
        this.pendingUi.set(requestId, { resolve: resolve as (result: UiResult) => void, reject });
        void this.post({ type: "uiRequest", requestId, request: interaction });
      });
    };
    return {
      choose: async ({ label, options, multiple, allowCustom, customPlaceholder }) => {
        return request<UiChoiceResult>({ type: "choice", label, options: [...options], multiple, allowCustom, ...(customPlaceholder ? { customPlaceholder } : {}) });
      },
      confirm: async ({ message, confirmLabel, cancelLabel }) => {
        return request<UiConfirmResult>({ type: "confirm", message, confirmLabel, cancelLabel });
      },
      input: async ({ label, placeholder, multiline }) => {
        return request<UiInputResult>({ type: "input", label, ...(placeholder ? { placeholder } : {}), multiline });
      }
    };
  }

  private postAgentEvent(sessionId: string, event: AgentStreamEvent): void {
    this.postWhenReady({ type: "agentEvent", sessionId, event });
  }

  private async postActiveExecution(sessionId: string): Promise<void> {
    const execution = this.activeExecutions.get(sessionId);
    if (!execution) return;
    await this.post({
      type: "executing",
      sessionId,
      value: true,
      turnId: execution.turnId,
      source: execution.source,
      ...(execution.planPath ? { planPath: execution.planPath } : {}),
      ...(execution.executePlan ? { executePlan: true } : {})
    });
    for (const event of execution.events) {
      await this.post({ type: "agentEvent", sessionId, event });
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

  private async addFileUris(uris: readonly vscode.Uri[], position?: number): Promise<void> {
    const references = await Promise.all(uris.map(async (uri) => {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) return directoryAttachment(uri);
      return fileAttachment(uri);
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
    const name = `${randomBytes(12).toString("hex")}${extension}`;
    const buffer = Buffer.from(data, "base64");
    const limit = this.application.storage.attachmentByteLimit();
    if (buffer.byteLength > limit) {
      throw new Error(`Attachments must be ${limit} bytes or smaller.`);
    }
    const directory = this.application.storage.directory("attachments");
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, name);
    await vscode.workspace.fs.writeFile(uri, buffer);
    await this.application.storage.pruneAttachments(this.application.storage.attachmentLimit(), uri);
    return { relativePath: this.application.storage.reference("attachments", name), uri, name };
  }

  private async storeTerminalOutput(text: string): Promise<{ relativePath: string; uri: vscode.Uri; name: string }> {
    const buffer = Buffer.from(text, "utf8");
    const limit = this.application.storage.attachmentByteLimit();
    if (buffer.byteLength > limit) {
      throw new Error(`Terminal output must be ${limit} bytes or smaller.`);
    }
    const name = `terminal-${randomBytes(12).toString("hex")}.log`;
    const directory = this.application.storage.directory("attachments");
    await vscode.workspace.fs.createDirectory(directory);
    const uri = vscode.Uri.joinPath(directory, name);
    await vscode.workspace.fs.writeFile(uri, buffer);
    await this.application.storage.pruneAttachments(this.application.storage.attachmentLimit(), uri);
    return { relativePath: this.application.storage.reference("attachments", name), uri, name };
  }

  private async deleteImage(relativePath: string): Promise<void> {
    const normalized = relativePath.replaceAll("\\", "/");
    if (!/^(?:\.dext|\.dext-global)\/attachments\/[a-f0-9]{24}\.(?:png|jpg|gif|webp|bmp)$/.test(normalized)) return;
    const uri = this.application.storage.uriForReference("attachments", normalized);
    if (!uri) return;
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
    <nav id="conversation-tabs" class="conversation-tabs" role="tablist" aria-label="Dext conversations"></nav>
    <main id="dext-main">
    <section id="result-section" class="result-section" aria-live="polite">
      <div id="result-heading" class="section-heading collapsible-heading" role="button" tabindex="0" aria-expanded="true">
        <span class="section-heading-label"><i class="section-chevron codicon codicon-chevron-down"></i><span>Conversation</span></span>
        <div class="section-heading-actions">
          <button id="result-toggle" class="icon-button" type="button" title="Collapse conversation" aria-label="Collapse conversation"><i class="codicon codicon-collapse-all"></i></button>
          <button id="result-fullscreen" class="icon-button panel-fullscreen" type="button" title="Maximize Conversation" aria-label="Maximize Conversation"><i class="codicon codicon-screen-full"></i></button>
        </div>
      </div>
      <div id="plan-toolbar" class="plan-toolbar" hidden>
        <div class="plan-target-group">
          <button id="plan-target" class="plan-target" type="button" title="Select a plan"><i class="codicon codicon-checklist"></i><span id="plan-target-label">New plan</span></button>
          <button id="plan-choose" class="plan-choose" type="button" title="Select a plan" aria-label="Select a plan"><i class="codicon codicon-chevron-down"></i></button>
        </div>
        <span id="plan-status" class="plan-status">New plan</span>
        <button id="plan-build" class="primary plan-build" type="button" title="Build the active plan"><i class="codicon codicon-play"></i><span>Build</span></button>
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
            <div id="permission-menu-shell" class="composer-menu">
              <button id="permission-control" class="composer-control" type="button" aria-haspopup="menu" aria-expanded="false"><i id="permission-control-icon" class="codicon codicon-shield" aria-hidden="true"></i><span class="composer-control-label">Permission</span><span id="permission-control-value" class="composer-control-value"></span><i class="codicon codicon-chevron-down"></i></button>
              <div id="permission-menu" class="composer-popover" role="menu" hidden></div>
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
            <button id="reload-methods" class="icon-button compact" type="button" title="Reload APIs" aria-label="Reload APIs"><i class="codicon codicon-refresh"></i></button>
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
    <dialog id="mcp-dialog" class="methods-dialog" aria-labelledby="mcp-dialog-title">
      <div class="methods-dialog-surface">
        <header class="methods-dialog-header">
          <div class="methods-dialog-title"><i class="codicon codicon-server"></i><span id="mcp-dialog-title">Global Resources</span><span id="mcp-count" class="count"></span></div>
          <div class="methods-dialog-actions">
            <button id="mcp-toggle" class="icon-button compact" type="button" title="Collapse resource categories" aria-label="Collapse resource categories"><i class="codicon codicon-collapse-all"></i></button>
            <button id="close-mcp" class="icon-button" type="button" title="Close global resources" aria-label="Close global resources"><i class="codicon codicon-close"></i></button>
          </div>
        </header>
        <div id="mcp-dialog-body" class="methods-dialog-body">
          <input id="mcp-search" class="resource-search" type="search" placeholder="Search global resources" aria-label="Search global resources">
          <div id="mcp-errors" class="config-errors"></div>
          <div id="mcp-servers"></div>
          <div id="mcp-empty" class="empty-state" hidden>No MCP servers configured.</div>
        </div>
      </div>
    </dialog>
    <dialog id="mcp-assistant-dialog" class="ui-dialog mcp-assistant-dialog" aria-labelledby="mcp-assistant-title">
      <form class="ui-dialog-surface" method="dialog">
        <header class="methods-dialog-header">
          <div id="mcp-assistant-title" class="methods-dialog-title"><i class="codicon codicon-sparkle"></i><span>Add MCP with AI</span></div>
          <button id="mcp-assistant-close" class="icon-button" type="button" title="Cancel" aria-label="Cancel"><i class="codicon codicon-close"></i></button>
        </header>
        <div class="mcp-assistant-body">
          <div class="mcp-assistant-message">Tell Dext what to connect. Paste MCP documentation, a registry URL, or a short description and Dext will draft the server configuration for you.</div>
          <textarea id="mcp-assistant-input" class="ui-dialog-input mcp-assistant-input" rows="5" placeholder="https://example.com/mcp/docs or describe the server"></textarea>
          <div id="mcp-assistant-status" class="mcp-assistant-status" aria-live="polite"></div>
          <details id="mcp-assistant-process" class="mcp-assistant-process" hidden>
            <summary><i class="disclosure-chevron codicon codicon-chevron-right"></i><span>Process</span><span id="mcp-assistant-process-meta" class="disclosure-meta"></span></summary>
            <div id="mcp-assistant-process-body" class="mcp-assistant-process-body"></div>
          </details>
          <div id="mcp-assistant-tools" class="mcp-assistant-tools" hidden></div>
          <label class="mcp-assistant-label" for="mcp-assistant-preview">Review configuration</label>
          <textarea id="mcp-assistant-preview" class="ui-dialog-input mcp-assistant-preview" rows="10" hidden></textarea>
          <label id="mcp-assistant-scope-label" class="mcp-assistant-label" for="mcp-assistant-scope" hidden>Save to</label>
          <select id="mcp-assistant-scope" class="ui-dialog-input" hidden><option value="project">Project (.dext/mcp)</option><option value="global">Dext global storage</option></select>
        </div>
        <footer class="ui-dialog-actions"><button id="mcp-assistant-generate" type="button">Generate</button><button id="mcp-assistant-save" type="button" hidden>Save MCP</button></footer>
      </form>
    </dialog>
    <dialog id="ui-dialog" class="ui-dialog" aria-labelledby="ui-dialog-title">
      <form id="ui-dialog-form" class="ui-dialog-surface" method="dialog">
        <header class="methods-dialog-header">
          <div id="ui-dialog-title" class="methods-dialog-title"></div>
          <button id="ui-dialog-close" class="icon-button" type="button" title="Cancel" aria-label="Cancel"><i class="codicon codicon-close"></i></button>
        </header>
        <div id="ui-dialog-body" class="ui-dialog-body"></div>
        <footer id="ui-dialog-actions" class="ui-dialog-actions"></footer>
      </form>
    </dialog>
  </div>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
