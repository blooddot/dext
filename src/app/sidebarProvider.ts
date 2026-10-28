import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { basename, extname, relative, sep } from "node:path";
import * as vscode from "vscode";
import { createConversationServices, type ConversationServices } from "./conversationSetup.js";
import type { DextApplication } from "./application.js";
import {
AttachmentStore,
writeExactClipboardText
} from "../shared/lib/attachmentStore.js";
import type { AgentSelection } from "../features/agents/contracts/agent.js";
import { DEFAULT_HISTORY_LIMITS, type ConversationHistoryStore, type DextHistorySession } from "../features/conversations/contracts/history.js";
import type { ConversationPreferences } from "../features/conversations/contracts/preferences.js";
import { planPathSegments } from "../features/conversations/domain/planFile.js";
import type { InputNotificationTarget } from "../features/conversations/host/inputNotifications.js";
import { normalizeInputReferenceSource } from "../features/workspace/domain/fileReference.js";
import { harnessPresetOrDefault } from "../features/agents/domain/harnessPresetDefault.js";
import { dedupeSkillIds, withoutSkills } from "../features/conversations/domain/agentSelection.js";
import type { McpServerConfig } from "../features/mcp/host/mcpRegistry.js";
import type { ProjectReferenceCandidate } from "../features/project/knowledge/projectReference.js";
import { RESOURCE_LABELS, resourceFileName, type ResourceKind, type ResourceScope, type ResourceSession } from "../features/resources/contracts/resourceSession.js";
import { FileSearchController } from "../features/workspace/host/fileSearchController.js";
import { ReadyMessageQueue } from "../shared/lib/readyMessageQueue.js";
import type { DextReplayEntry } from "../runner/dextResumeCache.js";
import {
activeWorkspaceSelection,
attachmentFileReference,
clipboardFileReference,
directoryAttachment,
fileAttachment,
selectionAttachment,
type SelectionTarget
} from "../platform/vscode/attachments.js";
import { clipboardFileReferences, copyFilePathKeepingFiles, copyFilePathKeepingLine } from "../platform/vscode/clipboardFiles.js";
import { openDextFileReference, openExternalLink } from "../platform/vscode/contextHost.js";
import { dextBuiltinNames } from "../features/workflow/domain/dextTypesStatus.js";
import type { WebviewResponse } from "../platform/webviewProtocol.js";
import { webviewRequestSchema } from "../platform/webviewProtocol.js";

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

/** The reverse of `imageExtension`, for opening an attachment in the annotation tab. */
import { IMAGE_MIME_TYPES } from "../features/conversations/host/attachmentImage.js";
import { ImageAnnotatorPanel } from "../features/conversations/host/imageAnnotatorPanel.js";

/** The Webview host. It owns the VS Code surface, the HTML shell, message
 * dispatch and the features outside this round (resources, MCP, attachments).
 * Conversation state lives in the controllers created by conversationSetup. */
export class DextSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "dext.sidebar";
  private view: vscode.WebviewView | undefined;
  private readonly messageQueue = new ReadyMessageQueue<WebviewResponse>();
  /** The Output channel that says whether the composer's types were sent. */
  private composerLog: vscode.OutputChannel | undefined;
  private readonly attachments = new AttachmentStore();
  private readonly conversation: ConversationServices;
  private projectReferences?: {
    search(query: string): Promise<ProjectReferenceCandidate[]> | ProjectReferenceCandidate[];
    open(objectId: string): Promise<void>;
  };
  // MCP manifest generation is an Agent-backed operation too, but it is not a
  // conversation turn and therefore does not belong in the execution
  // coordinator. Keeping its controller separately lets the shared Stop button
  // cancel it.
  private mcpAssistantExecution: { requestId: string; controller: AbortController } | undefined;
  private readonly pendingAttachmentDeletes = new Set<string>();
  private readonly resourceOperations = new Set<string>();
  private readonly resourcePreviews = new Map<string, string>();
  private resourcePreviewProvider: vscode.Disposable | undefined;
  private imageAnnotatorPanel: ImageAnnotatorPanel | undefined;
  private fileSearch = new FileSearchController(response => this.post(response));
  private disposed = false;
  // Model discovery opens an ACP session. Run it once when this sidebar first
  // needs Harness, or when the user explicitly switches to Harness, rather
  // than before every turn.
  private harnessModelsDiscovered = false;
  private harnessModelDiscovery: Promise<void> | undefined;
  private readonly piModelsDiscovered = new Set<string>();
  private readonly piModelDiscoveries = new Map<string, Promise<void>>();

  private get activeSession(): DextHistorySession {
    return this.conversation.controller.active();
  }

  private sessionInMap(sessionId: string): DextHistorySession | undefined {
    return this.conversation.controller.session(sessionId);
  }

  private running(sessionId: string): boolean {
    return this.conversation.coordinator.running(sessionId);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly application: DextApplication,
    private readonly history: ConversationHistoryStore,
    private readonly preferences: ConversationPreferences
  ) {
    this.conversation = createConversationServices({
      history,
      preferences,
      post: (message) => this.post(message),
      postWhenReady: (message) => this.postWhenReady(message),
      currentSelection: () => this.application.state().agentSelection,
      setAgentSelection: (selection) => this.application.setAgentSelection(selection),
      endAgentSession: (sessionId) => this.application.endAgentSession(sessionId),
      profiles: () => this.application.agentProfiles(),
      executeConversation: (mode, source, metadata) => this.application.executeConversation(mode, source, metadata),
      executeInput: (source, metadata, run) => this.application.executeInput(source, metadata, run),
      draftResource: (resource, source, metadata) => this.application.draftResource(resource, source, metadata),
      resolveSkillCommand: (id, selectedSkillIds, args, agent) => this.application.skills.resolveCommand(id, selectedSkillIds, args, agent),
      isTrustedLocalWorkspace: () => this.application.isTrustedLocalWorkspace(),
      readPlan: (planPath) => this.readPlanText(planPath),
      knownPlan: (reference) => Boolean(this.application.planUri(reference)),
      activeSessionId: () => this.activeSession.id,
      disposed: () => this.disposed,
      maxEventTextLength: () => vscode.workspace.getConfiguration("dext").get<number>("history.maxOutputLength", DEFAULT_HISTORY_LIMITS.maxOutputLength),
      resourceBusy: (sessionId) => this.resourceOperations.has(sessionId),
      notifyInput: async () => await vscode.window.showInformationMessage(
        "Dext: AI needs your response. Choose an option or enter an answer.", "View question"
      ) === "View question",
      openInputTarget: (target) => this.openInputTarget(target),
      postActiveExecution: (sessionId, switchId, hostInitiated) => this.postActiveExecution(sessionId, switchId, hostInitiated),
      flushAttachmentDeletes: () => this.flushAttachmentDeletes(),
      runningChanged: () => this.updateRunningContext()
    });
    // The composer holds the declaration in memory instead of reading the generated
    // file, so a reload that changed it — an MCP manifest was added, an API module was
    // written — has to hand over the new text. Without this the editor's TypeScript
    // service would know about a manifest the composer still typed as the built-in
    // surface, and an API module the composer could not resolve at all.
    this.application.onApiReload = () => {
      if (!this.view) return;
      void this.postDextTypes("reload");
    };
  }

  /**
   * Hands the composer everything its TypeScript worker cannot read for itself: the
   * generated declaration and the workspace's own API modules. Both are extra
   * libraries in the worker, and the second one is why `import { main } from
   * "dext/api/git/commit"` completes there.
   *
   * Both directions are logged to **Dext Input**, because the alternative is a composer
   * that completes nothing and no way to tell whether the input asked, the host
   * answered, or the Webview applied it.
   */
  private async postDextTypes(reason: "ready" | "requested" | "reload"): Promise<void> {
    const types = await this.application.composerTypes();
    this.logComposer(`types ${reason}: ${dextBuiltinNames(types.declaration).length} built-in name(s), ${types.modules.length} API module(s)`);
    this.postWhenReady({ type: "dextTypes", ...types });
  }

  /** The one line a broken composer can be diagnosed from, in the Output panel. */
  private logComposer(line: string): void {
    try {
      this.composerLog ??= vscode.window.createOutputChannel("Dext Input");
      this.composerLog.appendLine(`[composer] ${line}`);
    } catch {
      // A test harness or an unusual host may not offer an output channel.
    }
  }

  /** Data for explicit # completion/navigation only. This provider never participates in send. */
  setProjectReferenceSource(source: NonNullable<DextSidebarProvider["projectReferences"]>): void {
    this.projectReferences = source;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.fileSearch.dispose();
    this.fileSearch = new FileSearchController(response => this.post(response));
    this.view = view;
    // Lightweight host tests construct a partial application without the
    // optional image cache hook.
    this.application.setMcpImageWebview?.(view.webview);
    this.conversation.controller.clearOutputSignatures();
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
    void this.discoverHarnessModelsOnce().then(
      () => this.refresh(),
      // The picker remains usable with the last known models when dsh is not
      // installed or its provider is temporarily unavailable.
      () => undefined
    );
    void this.discoverPiModelsOnce().then(() => this.refresh()).catch(() => undefined);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.fileSearch.dispose();
        this.view = undefined;
        this.messageQueue.markNotReady();
      }
    });
  }

  async refresh(): Promise<void> {
    const state = this.application.state();
    state.agentSelection = this.validateInstalledSkills(state.agentSelection);
    await this.post({ type: "state", state });
    await this.conversation.controller.postPlanContext();
  }

  async resourcesChanged(): Promise<void> {
    await this.conversation.controller.reconcileInstalledSkills(this.installedSkillIds());
    await this.refresh();
  }

  /** Installed ids, read defensively because lightweight host tests build a
   * partial application object. */
  private installedSkillIds(): Set<string> {
    const catalog = (this.application as { skills?: { list(): Array<{ id: string }> } }).skills;
    return new Set((catalog?.list() ?? []).map((skill) => skill.id));
  }

  /** A persisted or late selection may name a skill that was uninstalled while
   * this conversation was closed. Drop it before the UI or a turn can use it. */
  private validateInstalledSkills(selection: AgentSelection): AgentSelection {
    if (selection.skills === undefined) return selection;
    const installed = this.installedSkillIds();
    const skills = dedupeSkillIds(selection.skills).filter((id) => installed.has(id));
    return skills.length ? { ...selection, skills } : withoutSkills(selection);
  }

  async setActivePlan(reference: string | undefined): Promise<void> {
    this.conversation.controller.hydrate();
    await this.conversation.plans.setActivePlan(reference);
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
    this.conversation.controller.hydrate();
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

  /** Reads the plan the user is editing. The path is validated before the read. */
  private async readPlanText(planPath: string): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error("Building a plan requires a trusted local workspace.");
    const target = this.application.planUri(planPath)
      ?? vscode.Uri.joinPath(folder.uri, ...planPathSegments(planPath));
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
  }

  private async persistResource(session: DextHistorySession): Promise<void> {
    if (!session.resource) return;
    await this.history.updateResourceContext(session.id, session.resource);
    await this.post({ type: "resourceContext", sessionId: session.id, resource: session.resource, busy: this.resourceOperations.has(session.id) });
    await this.conversation.controller.postConversationState();
  }

  private async resourceAction(sessionId: string, action: (session: DextHistorySession, resource: ResourceSession) => Promise<void>): Promise<void> {
    const session = this.sessionInMap(sessionId);
    if (!session?.resource) throw new Error("This resource conversation is no longer available.");
    if (this.running(sessionId) || this.resourceOperations.has(sessionId)) throw new Error("Wait for the current resource operation to finish.");
    this.resourceOperations.add(sessionId);
    try { await action(session, session.resource); }
    finally {
      this.resourceOperations.delete(sessionId);
      await this.post({ type: "resourceContext", sessionId, resource: session.resource });
    }
  }

  private async chooseResource(session: DextHistorySession, resource: ResourceSession): Promise<void> {
    if (resource.type === "file") {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Select file",
        ...(vscode.workspace.workspaceFolders?.[0] ? { defaultUri: vscode.workspace.workspaceFolders[0].uri } : {})
      });
      if (!picked?.[0]) return;
      await this.selectResourceFile(session, resource, picked[0]);
      return;
    }
    const available = await this.application.listResources(resource.type);
    const items = [
      { label: "$(add) New resource", description: `Create a new ${RESOURCE_LABELS[resource.type]}`, value: undefined as typeof available[number] | undefined },
      ...available.map((item) => ({ label: item.name, description: `${item.scope === "project" ? "Project" : "Global"} · ${item.path}`, value: item }))
    ];
    const selected = await vscode.window.showQuickPick(items, { title: `Select ${RESOURCE_LABELS[resource.type]}`, placeHolder: "Choose a resource to edit or create a new one" });
    if (!selected) return;
    const next: ResourceSession = { type: resource.type, scope: selected.value?.scope ?? resource.scope };
    if (selected.value) next.target = await this.application.readResource(next.type, next.scope, selected.value.path, selected.value.name);
    session.resource = next;
    await this.persistResource(session);
  }

  private async selectResourceFile(session: DextHistorySession, resource: ResourceSession, uri: vscode.Uri): Promise<void> {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error("Choose a file, not a directory.");
    if (resource.type !== "file") {
      const root = this.application.resourceRoot(resource.type, resource.scope).fsPath.replace(/[\\/]$/, "");
      const candidate = uri.fsPath.replace(/[\\/]$/, "");
      const path = relative(root, candidate).replaceAll("\\", "/");
      if (!path || path === ".." || path.startsWith(`../`) || /^[A-Za-z]:/.test(path)) {
        throw new Error(`Select a file inside the ${RESOURCE_LABELS[resource.type]} directory.`);
      }
      const target = await this.application.readResource(resource.type, resource.scope, path, basename(path));
      session.resource = { type: resource.type, scope: resource.scope, target };
      await this.persistResource(session);
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder || folder.uri.scheme !== "file") throw new Error("File resources must be inside the current workspace.");
    const path = vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
    const target = await this.application.readResource("file", "project", path, basename(path));
    session.resource = { type: "file", scope: "project", target };
    await this.persistResource(session);
  }

  private async previewResource(resource: ResourceSession): Promise<void> {
    const draft = resource.draft ?? resource.target;
    if (!draft) throw new Error("Generate a draft or select a resource first.");
    const name = resource.target?.path ?? resourceFileName(resource.type, draft.name);
    const files = [
      { label: name, description: "Primary resource", content: draft.content, previous: resource.target?.content },
      ...(draft.files ?? []).map((file) => ({ label: file.path, description: "Supporting file", content: file.content,
        previous: resource.target?.files?.find((saved) => saved.path === file.path)?.content }))
    ];
    const selected = files.length > 1
      ? await vscode.window.showQuickPick(files, { title: "Preview resource files", placeHolder: "Choose a file to review", matchOnDescription: true })
      : files[0];
    if (!selected) return;
    this.resourcePreviewProvider ??= vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider("dext-resource-preview", {
        provideTextDocumentContent: (uri) => this.resourcePreviews.get(uri.toString()) ?? ""
      }),
      vscode.workspace.onDidCloseTextDocument((document) => this.resourcePreviews.delete(document.uri.toString()))
    );
    const uri = (label: string, content: string): vscode.Uri => {
      const value = vscode.Uri.from({ scheme: "dext-resource-preview", path: `/${randomBytes(12).toString("hex")}/${label}/${selected.label}` });
      this.resourcePreviews.set(value.toString(), content);
      return value;
    };
    if (resource.draft && selected.previous !== undefined) {
      await vscode.commands.executeCommand("vscode.diff", uri("saved", selected.previous), uri("draft", selected.content), `${selected.label} — Resource changes`);
    } else {
      const document = await vscode.workspace.openTextDocument(uri("preview", selected.content));
      await vscode.window.showTextDocument(document, { preview: true });
    }
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

  /** Inserts reference expressions into the composer, keeping the migrated resource pages working. */
  insertReferences(expressions: readonly string[]): void {
    if (!expressions.length) return;
    this.showChat();
    this.postWhenReady({ type: "insertFileReferences", expressions: [...expressions] });
  }

  /** Routes a resource tab action into the existing edit/creation conversation flow. */
  async editResource(type: ResourceKind, scope: ResourceScope): Promise<void> {
    await this.startConversation(false, { type, scope });
  }

  addMcp(): void {
    this.postWhenReady({ type: "mcpAssistant" });
  }

  async newConversation(): Promise<void> {
    this.conversation.controller.hydrate();
    await this.startConversation();
  }

  // A new conversation opens its own tab, while clearing replaces the
  // conversation shown in the tab that is already active.
  private async startConversation(replaceActiveTab = false, resource?: ResourceSession): Promise<void> {
    const session = await this.conversation.controller.start(replaceActiveTab, resource);
    // Another tab can be opened while preferences/history are being written.
    if (this.activeSession.id !== session.id) return;
    this.updateRunningContext();
    await this.refresh();
    await this.post({ type: "outputSession", session, hostInitiated: true });
  }

  // History hands over its own copy of a conversation; an already open one
  // keeps the in-memory instance so that a running turn stays attached to it.
  async openConversation(session: DextHistorySession): Promise<void> {
    await this.conversation.controller.open(session);
  }

  async renameConversation(sessionId: string, title: string): Promise<void> {
    await this.conversation.controller.rename(sessionId, title);
  }

  private discoverHarnessModelsOnce(): Promise<void> {
    const selection = this.conversation.controller.selection(this.activeSession.id)
      ?? this.application.state().agentSelection;
    if (
      this.harnessModelsDiscovered
      || selection.profileId !== "deepseek-harness"
      || !this.application.agentProfiles().some((profile) => profile.id === "deepseek-harness")
    ) return Promise.resolve();
    if (this.harnessModelDiscovery) return this.harnessModelDiscovery;
    this.harnessModelDiscovery = this.application.discoverHarnessModels()
      .then(() => { this.harnessModelsDiscovered = true; })
      .finally(() => { this.harnessModelDiscovery = undefined; });
    return this.harnessModelDiscovery;
  }

  private async refreshHarnessPresets(): Promise<void> {
    await this.application.discoverHarnessPresets();
    await this.refresh();
  }

  private discoverPiModelsOnce(): Promise<void> {
    const selection = this.conversation.controller.selection(this.activeSession.id) ?? this.application.state().agentSelection;
    if (selection.profileId !== "pi" || !this.application.agentProfiles().some((profile) => profile.id === "pi")) return Promise.resolve();
    const key = `${this.application.piDiscoveryKey()}\u0000${selection.model ?? ""}`;
    if (this.piModelsDiscovered.has(key)) return Promise.resolve();
    const previous = this.piModelDiscoveries.get(key); if (previous) return previous;
    const operation = this.application.discoverPiModels(selection.model || undefined).then(() => { this.piModelsDiscovered.add(key); })
      .finally(() => this.piModelDiscoveries.delete(key));
    this.piModelDiscoveries.set(key, operation); return operation;
  }

  async renameTurn(sessionId: string, turnId: string, title: string): Promise<void> {
    await this.conversation.controller.renameTurn(sessionId, turnId, title);
  }

  async pinConversation(sessionId: string, pinned: boolean): Promise<void> {
    await this.conversation.controller.pin(sessionId, pinned);
  }

  async moveConversation(sessionId: string, beforeSessionId: string | null): Promise<void> {
    await this.conversation.controller.move(sessionId, beforeSessionId);
  }

  async closeTab(sessionId: string): Promise<void> {
    this.conversation.controller.hydrate();
    const wasActive = this.activeSession.id === sessionId;
    await this.conversation.controller.close(sessionId);
    // Closing the visible tab repaints the shared sidebar state for the
    // neighbour; closing a background tab never did.
    if (wasActive) await this.refresh();
  }

  async retryTurn(sessionId: string, turnId: string): Promise<void> {
    this.conversation.controller.hydrate();
    if (this.running(sessionId)) throw new Error("Stop this Dext turn before retrying a conversation turn.");
    const session = this.sessionInMap(sessionId) ?? this.history.list(true).find((item) => item.id === sessionId);
    const turn = session?.turns.find((item) => item.id === turnId);
    if (!session || !turn) throw new Error("Conversation turn not found.");
    if (session.archivedAt) {
      await this.history.setArchived(sessionId, false);
      delete session.archivedAt;
    }
    await vscode.commands.executeCommand("dext.sidebar.focus");
    this.showChat();
    await this.openConversation(session);
    if (turn.resourceSource) {
      await this.run(turn.mode ?? this.application.state().agentSelection.mode ?? "agent", turn.input, undefined, false, undefined, turn.resourceSource);
    } else {
      await this.run(turn.mode ?? this.application.state().agentSelection.mode ?? "agent", turn.input);
    }
  }

  async continueTurn(sessionId: string, turnId: string): Promise<void> {
    this.conversation.controller.hydrate();
    if (this.running(sessionId)) throw new Error("Stop this Dext turn before continuing a conversation turn.");
    const continuation = this.conversation.coordinator.takeContinuation(sessionId, turnId);
    if (!continuation) throw new Error("This Code turn cannot be continued after the extension was reloaded. Retry it instead.");
    const session = this.sessionInMap(sessionId) ?? this.history.list(true).find((item) => item.id === sessionId);
    const turn = session?.turns.find((item) => item.id === turnId);
    if (!session || !turn || turn.mode !== "code") throw new Error("Conversation Code turn not found.");
    if (session.archivedAt) {
      await this.history.setArchived(sessionId, false);
      delete session.archivedAt;
    }
    await vscode.commands.executeCommand("dext.sidebar.focus");
    this.showChat();
    await this.openConversation(session);
    await this.run("code", turn.input, undefined, false, continuation);
  }

  async deleteTurn(turnId: string, sessionId = this.activeSession.id): Promise<void> {
    await this.conversation.controller.deleteTurn(turnId, sessionId);
  }

  async forgetConversation(sessionId: string): Promise<void> {
    await this.conversation.controller.forget(sessionId);
  }

  setInput(source: string): void {
    this.postWhenReady({ type: "setInput", source });
  }

  editTurnInput(sessionId: string, turnId: string): void {
    this.conversation.controller.hydrate();
    const execution = this.conversation.coordinator.active(sessionId);
    const session = this.sessionInMap(sessionId) ?? this.history.list(true).find((item) => item.id === sessionId);
    const source = execution?.turnId === turnId
      ? execution.source
      : session?.turns.find((turn) => turn.id === turnId)?.input;
    if (source === undefined) throw new Error("Conversation turn not found.");
    this.setInput(source);
  }

  /** The keyboard and Command Palette route into the same abort the composer's
   * Stop button uses, so there is only one way a turn ends early. */
  stopExecution(): void {
    if (this.conversation.coordinator.abort(this.activeSession.id)) return;
    if (this.mcpAssistantExecution) {
      this.mcpAssistantExecution.controller.abort();
      return;
    }
    throw new Error("No Dext turn is running in this conversation.");
  }

  async addSelectionToChat(target?: SelectionTarget): Promise<void> {
    const attachment = await selectionAttachment(target);
    this.postWhenReady({
      type: "insertFileReferences",
      expressions: [attachmentFileReference(attachment).expression]
    });
  }

  async copySelectionWithContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    // VS Code's own multi-cursor copy joins every selection, and Dext can only
    // stage one range, so that copy is left entirely to VS Code.
    if (editor && editor.selections.length > 1) {
      await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
      return vscode.env.clipboard.readText();
    }
    const attachment = await selectionAttachment();
    const copiedText = await writeExactClipboardText(vscode.env.clipboard, attachment.text);
    const reference = clipboardFileReference(attachment.reference);
    if (reference) {
      this.attachments.stageClipboard(attachment.text, reference);
    } else {
      this.attachments.clearClipboard();
    }
    return copiedText;
  }

  /** Explorer Copy Path. Dext Input paste turns the path text into references,
   * but an Explorer paste reads VS Code's file list instead, so the files stay
   * pasteable while the paths wait here for the Dext paste that consumes them. */
  async copyFilePathWithFiles(): Promise<void> {
    this.attachments.stageFileCopy(await copyFilePathKeepingFiles());
  }

  /** Editor Copy Path with nothing selected. VS Code keeps its copy-line
   * behavior; the path waits here for the Dext paste that consumes it. */
  async copyFilePathWithLine(): Promise<void> {
    const { path, clipboardText } = await copyFilePathKeepingLine();
    this.attachments.stageFileCopy(path, clipboardText);
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
    this.fileSearch.dispose();
    this.disposed = true;
    this.conversation.dispose();
    for (const session of this.conversation.controller.sessionsList()) {
      if (this.conversation.coordinator.running(session.id)) this.application.endAgentSession(session.id);
    }
    this.mcpAssistantExecution?.controller.abort();
    this.mcpAssistantExecution = undefined;
    this.resourcePreviewProvider?.dispose();
    this.imageAnnotatorPanel?.dispose();
    this.resourcePreviews.clear();
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
          // A reloaded document starts request ids at one; invalidate the previous document's work.
          this.fileSearch?.dispose();
          this.fileSearch = new FileSearchController(response => this.post(response));
          const pendingMessages = this.messageQueue.markReady();
          this.conversation.controller.hydrate();
          this.updateRunningContext();
          await this.refresh();
          await this.conversation.controller.postConversationState();
          await this.post({ type: "outputSession", session: this.activeSession });
          await this.postDextTypes("ready");
          await this.postActiveExecution(this.activeSession.id);
          await this.flushPendingMessages(pendingMessages);
          break;
        }
        case "composerTypes": {
          await this.postDextTypes("requested");
          break;
        }
        case "composerTypesApplied": {
          this.logComposer(`applied by the input: ${request.builtins} built-in name(s), ${request.modules} API module(s)`);
          break;
        }
        case "executeInput":
          await (request.resourceSource
            ? this.run(request.mode, request.source, request.planPath, false, undefined, request.resourceSource)
            : this.run(request.mode, request.source, request.planPath));
          break;
        case "openResourceCreator":
          this.conversation.controller.hydrate();
          await this.startConversation(false, { type: "api", scope: this.application.state().resourceRoots?.project ? "project" : "global" });
          break;
        case "resourceOptions":
          await this.resourceAction(request.sessionId, async (session, resource) => {
            const requestedScope = request.resourceType === "file" ? "project" : request.scope;
            if (resource.type !== request.resourceType) {
              session.resource = { type: request.resourceType, scope: requestedScope };
            } else if (resource.scope !== requestedScope) {
              // Changing destination makes an explicit copy; it never moves or overwrites the source.
              const document = resource.draft ?? resource.target;
              session.resource = { type: resource.type, scope: requestedScope,
                ...(document ? { draft: { name: document.name, content: document.content, ...(document.files ? { files: structuredClone(document.files) } : {}) } } : {}) };
            }
            await this.persistResource(session);
          });
          break;
        case "selectDroppedFile": {
          const uri = /^vscode-remote:\/\//i.test(request.path) || /^file:\/\//i.test(request.path)
            ? vscode.Uri.parse(request.path, true)
            : vscode.Uri.file(request.path);
          if (request.target === "plan") {
            await this.setActivePlanFromUri(uri);
          } else {
            if (!request.sessionId) throw new Error("The resource conversation is no longer available.");
            await this.resourceAction(request.sessionId, (session, resource) => this.selectResourceFile(session, resource, uri));
          }
          break;
        }
        case "chooseResource":
          await this.resourceAction(request.sessionId, (session, resource) => this.chooseResource(session, resource));
          break;
        case "previewResource":
          await this.resourceAction(request.sessionId, (_session, resource) => this.previewResource(resource));
          break;
        case "saveResource":
          await this.resourceAction(request.sessionId, async (session, resource) => {
            const target = await this.application.saveResource(resource);
            session.resource = { type: resource.type, scope: resource.scope, target, saved: true };
            await this.persistResource(session);
            await this.application.reload();
            await this.refresh();
          });
          break;
        case "agentInputResponse":
          this.conversation.interactions.respondAgent(request.sessionId, request.turnId, request.requestId, request.answers);
          break;
        case "uiResponse":
          if (!this.conversation.interactions.respondUi(request.sessionId, request.turnId, request.requestId, request.response)) {
            await this.post({ type: "error", message: "Invalid or expired interaction response." });
          }
          break;
        case "stopExecution":
          this.conversation.coordinator.abortTurn(request.turnId);
          if (this.mcpAssistantExecution?.requestId === request.turnId) {
            this.mcpAssistantExecution.controller.abort();
          }
          break;
        case "retryTurn":
          await vscode.commands.executeCommand("dext.history.retryTurn", {
            sessionId: request.sessionId ?? this.activeSession.id, turnId: request.turnId
          });
          break;
        case "continueTurn":
          await this.continueTurn(request.sessionId ?? this.activeSession.id, request.turnId);
          break;
        case "forkFromTurn":
          await vscode.commands.executeCommand("dext.history.forkFromTurn", {
            sessionId: request.sessionId ?? this.activeSession.id,
            turnId: request.turnId
          });
          break;
        case "renameTurn":
          await vscode.commands.executeCommand("dext.history.renameTurn", {
            sessionId: request.sessionId,
            turnId: request.turnId
          });
          break;
        case "deleteTurn":
          await vscode.commands.executeCommand("dext.history.deleteTurn", {
            sessionId: request.sessionId ?? this.activeSession.id, turnId: request.turnId
          });
          break;
        case "copyTurn":
          await vscode.commands.executeCommand("dext.history.copyTurn", {
            sessionId: request.sessionId, turnId: request.turnId
          });
          break;
        case "openSpillFile": {
          const path = this.history.spillPath(request.sessionId, request.turnId);
          if (!path) await vscode.window.showInformationMessage("This turn has no truncated output.");
          else await vscode.window.showTextDocument(vscode.Uri.file(path));
          break;
        }
        case "buildPlan":
          await this.conversation.plans.build(request.planPath);
          break;
        case "choosePlan":
          await this.choosePlan();
          break;
        case "newConversation":
          await this.newConversation();
          break;
        case "selectConversation": {
          const selected = this.sessionInMap(request.sessionId);
          if (!selected) throw new Error("Conversation not found.");
          this.conversation.controller.activate(selected, request.switchId);
          break;
        }
        case "outputSessionRefMiss": {
          const selected = this.sessionInMap(request.sessionId);
          if (!selected) break;
          this.conversation.controller.markOutputPosted(selected);
          await this.post({ type: "outputSession", session: selected, ...(request.switchId !== undefined ? { switchId: request.switchId } : {}), ...(request.hostInitiated ? { hostInitiated: true as const } : {}) });
          break;
        }
        case "closeConversation":
          await this.conversation.controller.close(request.sessionId);
          break;
        case "moveConversation":
          await this.conversation.controller.move(request.sessionId, request.beforeSessionId);
          break;
        case "pinConversation":
          await this.conversation.controller.pin(request.sessionId, request.pinned);
          break;
        case "harnessPresetAction":
          await this.refreshHarnessPresets();
          break;
        case "agentSelection":
          {
          // Reject late menu clicks after execution has already started.
          if (this.running(this.activeSession.id)) {
            await this.refresh();
            break;
          }
          const previousSelection = this.conversation.controller.selection(this.activeSession.id);
          const previousProfileId = previousSelection?.profileId;
          // The Harness preset catalog is the only source of preset choices, so
          // an unset preset reads as the default it will run as. Only a Harness
          // conversation holds a preset: switching another provider's
          // conversation to the Harness starts it on that default, which is not
          // the preset change this guard rejects.
          const previousPreset = previousProfileId === "deepseek-harness" ? harnessPresetOrDefault(previousSelection?.agentPreset) : undefined;
          const requestedPreset = request.selection.profileId === "deepseek-harness"
            ? harnessPresetOrDefault(request.selection.agentPreset)
            : request.selection.agentPreset ?? "";
          if (this.activeSession.turns.length && previousPreset !== undefined && requestedPreset !== previousPreset) {
            throw new Error("Choose an Agent preset in a new conversation. This conversation keeps its original preset.");
          }
          // Skills are per-conversation. An absent field preserves the array
          // the tab already had; a present field replaces it, and ids that are
          // no longer installed are dropped rather than carried into a turn.
          const requestedSkills = request.selection.skills === undefined
            ? previousSelection?.skills
            : dedupeSkillIds(request.selection.skills).filter((id) => this.installedSkillIds().has(id));
          const selection = {
            mode: this.activeSession.resource ? "ask" : request.selection.mode,
            permission: request.selection.permission,
            profileId: request.selection.profileId,
            model: request.selection.model,
            ...(request.selection.agentPreset !== undefined || previousSelection?.agentPreset ? { agentPreset: requestedPreset } : {}),
            reasoningEffort: request.selection.reasoningEffort,
            speed: request.selection.speed,
            serviceTier: request.selection.serviceTier,
            ...(!this.activeSession.resource && requestedSkills?.length ? { skills: requestedSkills } : {})
          } satisfies AgentSelection;
          const sessionId = this.activeSession.id;
          this.conversation.controller.setSelection(sessionId, selection);
          this.updateRunningContext();
          // Publish the accepted selection before storage or ACP discovery can
          // delay it. Execution must also see it if the user sends immediately.
          const refresh = this.refresh();
          if (selection.profileId === "pi") {
            void this.discoverPiModelsOnce().then(() => { if (!this.disposed) return this.refresh(); }).catch(() => undefined);
          }
          if (selection.profileId === "deepseek-harness" && previousProfileId !== "deepseek-harness") {
            this.harnessModelsDiscovered = false;
            void this.discoverHarnessModelsOnce()
              .then(() => {
                // Refresh current state, never the selection that started this
                // request: the user may have changed models or conversations.
                if (!this.disposed) return this.refresh();
              })
              // Keep the last known models usable if discovery is unavailable.
              .catch(() => undefined);
          }
          await Promise.all([refresh, this.preferences.setConversationSelection(sessionId, selection)]);
          break;
          }
        case "openFileReference":
          await this.openReference(request.reference);
          break;
        case "searchProjectReferences": {
          try {
            const items = this.projectReferences ? await this.projectReferences.search(request.query) : [];
            await this.post({ type: "projectReferenceSearchResult", requestId: request.requestId, items });
          } catch (error) {
            await this.post({ type: "projectReferenceSearchResult", requestId: request.requestId, items: [], error: error instanceof Error ? error.message : String(error) });
          }
          break;
        }
        case "openProjectReference":
          if (!this.projectReferences) throw new Error("Project knowledge is not available in this workspace.");
          await this.projectReferences.open(request.objectId);
          break;
        case "openBuiltinApiDefinition":
          // Every built-in API is declared in the generated `dext.d.ts` now, so
          // that is what the API panel opens; tsserver serves F12 from it too.
          await vscode.window.showTextDocument(vscode.Uri.file(this.application.dextTypesPath()), { preview: true });
          break;
        case "openExternalLink":
          await openExternalLink(request.url);
          break;
        case "searchFiles": {
          await this.fileSearch.search(request);
          break;
        }
        case "resolveDroppedFiles": {
          const references = await clipboardFileReferences(request.paths.join("\n"));
          await this.post({
            type: "resolveDroppedFilesResult",
            requestId: request.requestId,
            expressions: references?.map((reference) => reference.expression) ?? [],
            ...(!references?.length ? { error: "Could not reference the dropped files. Check that they still exist and are accessible." } : {})
          });
          break;
        }
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
          // A Copy Path that handed the clipboard back keeps no text of its own
          // for an Explorer copy: VS Code's file list replaced it. The staged
          // paths stand in for that text, and never for a copy the user made
          // afterwards.
          const stagedPaths = this.attachments.stagedFilePath(text);
          const copiedText = text || stagedPaths || "";
          let codeReference: ReturnType<typeof this.attachments.clipboardReference> = undefined;
          let fileReferences: Awaited<ReturnType<typeof clipboardFileReferences>>;
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
              // When that selection is outside the workspace,
              // deliberately leave the text untouched. In particular, do not
              // fall back to a stale staged reference from an earlier project
              // selection with identical contents.
              if (hasMatchingSelection) {
                const current = activeWorkspaceSelection();
                if (current) {
                  const attachment = await selectionAttachment();
                  codeReference = clipboardFileReference(attachment.reference);
                } else {
                  // The matching selection is known to be non-project.
                  // Drop any older staged context as well, so a
                  // second paste after focus changes cannot resurrect a ref
                  // for this external content.
                  this.attachments.clearClipboard();
                }
              } else {
                // File Copy Path carries the original resources, including
                // images. Resolve paths before falling back to staged context.
                fileReferences = await clipboardFileReferences(text);
                if (!fileReferences && stagedPaths) {
                  fileReferences = await clipboardFileReferences(stagedPaths);
                }
                if (!fileReferences) codeReference = this.attachments.clipboardReference(text);
              }
            }
          } catch (error) {
            await this.post({
              type: "clipboardReadResult",
              requestId: request.requestId,
              success: true,
              text: codeReference?.expression ?? copiedText,
              contextAttached: false,
              ...(codeReference ? { codeReference } : {})
            });
            throw error;
          }
          await this.post({
            type: "clipboardReadResult",
            requestId: request.requestId,
            success: true,
            text: request.purpose === "code"
              ? fileReferences?.map((reference) => reference.expression).join(" ") ?? codeReference?.expression ?? copiedText
              : copiedText,
            contextAttached: false,
            ...(codeReference ? { codeReference } : {}),
            ...(fileReferences ? { fileReferences } : {})
          });
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
          if (this.conversation.coordinator.anyRunning()) this.pendingAttachmentDeletes.add(request.relativePath);
          else await this.deleteImage(request.relativePath);
          break;
        case "reload":
          await this.application.reload();
          await this.refresh();
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
        ...("sessionId" in request && request.sessionId ? { sessionId: request.sessionId } : {}),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async run(mode: "agent" | "ask" | "plan" | "code", source: string, planPath?: string, executePlan = false, codeContinuation?: readonly DextReplayEntry[], resourceSource?: "describe" | "import"): Promise<void> {
    this.conversation.controller.hydrate();
    await this.conversation.coordinator.execute(this.activeSession, mode, normalizeInputReferenceSource(source), {
      ...(planPath !== undefined ? { planPath } : {}),
      executePlan,
      ...(codeContinuation ? { codeContinuation } : {}),
      ...(resourceSource ? { resourceSource } : {})
    });
  }

  // The stop keybinding is only live while a turn is running, which keeps a
  // convenient chord from shadowing anything the rest of the time.
  private updateRunningContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "dext.running",
      this.running(this.activeSession.id) || Boolean(this.mcpAssistantExecution)
    );
    void vscode.commands.executeCommand(
      "setContext",
      "dext.planMode",
      (this.conversation.controller.selection(this.activeSession.id)?.mode
        ?? this.application.state().agentSelection.mode
        ?? "agent") === "plan"
    );
  }

  private async flushAttachmentDeletes(): Promise<void> {
    const pending = [...this.pendingAttachmentDeletes];
    this.pendingAttachmentDeletes.clear();
    for (const relativePath of pending) await this.deleteImage(relativePath);
  }

  private async postActiveExecution(sessionId: string, switchId?: number, hostInitiated = false): Promise<void> {
    const execution = this.conversation.coordinator.active(sessionId);
    if (!execution) return;
    // Snapshot before awaiting the executing message. Events arriving after
    // this point are delivered through the normal single-event path and must
    // not be replayed a second time in the restore batch.
    const replayEvents = [...execution.events];
    await this.post({
      type: "executing",
      sessionId,
      value: true,
      turnId: execution.turnId,
      source: execution.source,
      mode: execution.mode,
      startedAt: execution.startedAt,
      ...(execution.planPath ? { planPath: execution.planPath } : {}),
      ...(execution.executePlan ? { executePlan: true } : {}),
      ...(switchId !== undefined ? { switchId } : {}),
      ...(hostInitiated ? { hostInitiated: true as const } : {})
    });
    if (replayEvents.length) {
      // A tab restore can contain dozens of buffered events. Send one IPC
      // message instead of awaiting one Webview post per event.
      await this.post({ type: "agentEvents", sessionId, events: replayEvents, ...(switchId !== undefined ? { switchId } : {}) });
    }
    const focus = this.conversation.interactions.pendingFocus(sessionId, execution.turnId);
    if (focus) this.postWhenReady({ type: "focusAgentInput", ...focus });
  }

  private async openInputTarget(target: InputNotificationTarget): Promise<void> {
    // Asking the host to focus a view that is already on screen rewrites the
    // layout the reader chose: a maximized Secondary Side Bar drops back to
    // its docked width. Only a Dext the reader cannot see is revealed here; an
    // on-screen one keeps the display state it has and still takes focus,
    // because the Webview focuses the question field.
    if (this.view?.visible !== true) await vscode.commands.executeCommand("dext.sidebar.focus");
    if (!this.conversation.interactions.isWaiting(target) || this.disposed
      || this.conversation.coordinator.turnOf(target.sessionId) !== target.turnId) return;
    const session = this.sessionInMap(target.sessionId);
    if (!session) return;
    this.conversation.interactions.requestFocus(target);
    await this.openConversation(session);
  }

  private async post(message: WebviewResponse): Promise<void> {
    if (!this.messageQueue.isReady) {
      return;
    }
    const view = this.view;
    if (!view) {
      return;
    }
    await view.webview.postMessage(message);
  }

  private postWhenReady(message: WebviewResponse): void {
    if (this.messageQueue.enqueue(message)) {
      return;
    }
    if (!this.view) {
      return;
    }
    void this.post(message);
  }

  private async flushPendingMessages(messages: readonly WebviewResponse[]): Promise<void> {
    for (const message of messages) await this.post(message);
  }

  private async addFileUris(uris: readonly vscode.Uri[]): Promise<void> {
    const references = await Promise.all(uris.map(async (uri) => {
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) return directoryAttachment(uri);
      return fileAttachment(uri);
    }));
    this.postWhenReady({
      type: "insertFileReferences",
      expressions: references.map((reference) => reference.expression)
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

  /** A Dext image attachment opens in the annotation tab; every other reference
   * keeps the ordinary editor behavior. Clicking the chip posts the same request
   * as clicking an `@` reference, so both land in the same tab. */
  private async openReference(reference: string): Promise<void> {
    const normalized = reference.replaceAll("\\", "/");
    const uri = this.application.storage.uriForReference("attachments", normalized);
    if (uri && IMAGE_MIME_TYPES[extname(uri.fsPath).toLowerCase()]) {
      this.imageAnnotatorTab().open(normalized);
      return;
    }
    await openDextFileReference(reference, this.application.storage);
  }

  /** Built on first use: it needs this provider's own extension Uri and composer. */
  private imageAnnotatorTab(): ImageAnnotatorPanel {
    return this.imageAnnotatorPanel ??= new ImageAnnotatorPanel({
      extensionUri: this.extensionUri,
      storage: this.application.storage,
      onInsert: (text, previous) => this.postWhenReady({ type: "insertAnnotations", text, ...(previous ? { previous } : {}) })
    });
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

  /**
   * The cache key for the Webview's own assets: the bundle's modification time.
   *
   * A version number is not enough — reinstalling the same version is exactly the case
   * where the renderer keeps serving the old `main.js` — so the timestamp of the file
   * the editor runs from is what makes a rebuilt bundle a different URL.
   */
  private assetStamp(): string {
    try {
      return String(statSync(vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "main.js").fsPath).mtimeMs);
    } catch {
      // Only reachable for a virtual or remote extension host, where `asWebviewUri`
      // already gives each asset a unique URL.
      return "0";
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    // Every asset URL carries the bundle's timestamp, so a rebuilt `dist/` is a *new*
    // URL. Without it a Webview can be served the previous `main.js` from the renderer's
    // cache — the extension changes, the editor does not, and nothing says why.
    const stamp = this.assetStamp();
    const asset = (...parts: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts)).with({ query: `v=${stamp}` });
    const script = asset("dist", "webview", "main.js");
    const style = asset("dist", "webview", "main.css");
    const codicons = asset("dist", "codicons", "codicon.css");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'; worker-src blob:; connect-src ${webview.cspSource};">
  <meta name="dext-script-nonce" content="${nonce}">
  <meta name="dext-mermaid" content="${asset("dist", "webview", "mermaid.js").toString()}">
  <meta name="dext-editor-worker" content="${asset("dist", "webview", "editor.worker.js").toString()}">
  <link rel="stylesheet" href="${codicons.toString()}">
  <link rel="stylesheet" href="${asset("dist", "markdown", "github-markdown.css").toString()}">
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
        </div>
      </div>
      <div id="result-body" class="collapsible-body result-body" tabindex="-1"><div id="result"></div></div>
    </section>

    <section id="input-section" class="input-section">
      <div id="input-heading" class="section-heading collapsible-heading" role="button" tabindex="0" aria-expanded="true">
        <span class="section-heading-label"><i class="section-chevron codicon codicon-chevron-down"></i><span>Input</span></span>
        <div class="section-heading-actions">
          <button id="create-resource" class="icon-button" type="button" title="Create resource" aria-label="Create resource"><i class="codicon codicon-add"></i></button>
        </div>
      </div>
      <div id="input-body" class="collapsible-body input-body">
        <div id="plan-toolbar" class="plan-toolbar" hidden>
          <div class="plan-target-group">
            <button id="plan-target" class="plan-target" type="button" title="Select a plan"><i class="codicon codicon-checklist"></i><span id="plan-target-label">New plan</span></button>
            <button id="plan-choose" class="plan-choose" type="button" title="Select a plan" aria-label="Select a plan"><i class="codicon codicon-chevron-down"></i></button>
          </div>
          <span id="plan-status" class="plan-status">New plan</span>
          <button id="plan-build" class="primary plan-build" type="button" title="Build the active plan" aria-label="Build the active plan"><i class="codicon codicon-play" aria-hidden="true"></i><span>Build</span></button>
        </div>
        <div id="resource-toolbar" class="plan-toolbar resource-toolbar" hidden>
          <div class="plan-target-group">
            <button id="resource-target" class="plan-target" type="button" title="Select a resource"><i class="codicon codicon-file-code"></i><span id="resource-target-label">New resource</span></button>
            <button id="resource-choose" class="plan-choose" type="button" title="Select a resource" aria-label="Select a resource"><i class="codicon codicon-chevron-down"></i></button>
          </div>
          <span id="resource-status" class="plan-status" aria-live="polite"></span>
          <button id="resource-preview" class="resource-preview" type="button">Preview</button>
          <button id="resource-save" class="primary resource-save" type="button">Save</button>
        </div>
        <div id="resource-source-toggle" class="resource-source-toggle" role="tablist" aria-label="Skill creation mode" hidden>
          <button id="resource-source-describe" type="button" role="tab" data-resource-source="describe" aria-selected="true">Describe</button>
          <button id="resource-source-import" type="button" role="tab" data-resource-source="import" aria-selected="false">Import</button>
        </div>
        <section id="input-shell" class="input-panel unified-input">
          <div id="code-editor" class="code-editor" aria-label="Dext input"></div>
          <button id="attach-files" class="composer-attach icon-button" type="button" title="Attach workspace files, or hold Shift and drag files into the input" aria-label="Attach workspace files"><i class="codicon codicon-attach"></i></button>
        </section>

        <div id="input-error" class="input-error" role="alert" hidden>
          <span id="input-error-message" class="input-error-message"></span>
          <button id="dismiss-input-error" class="icon-button input-error-close" type="button" title="Dismiss error" aria-label="Dismiss error"><i class="codicon codicon-close" aria-hidden="true"></i></button>
        </div>

        <div id="attachment-bar" class="attachment-bar hidden" aria-label="Image attachments"></div>

        <div class="action-row">
          <div id="composer-controls" class="composer-controls">
            <div class="composer-menu">
              <button id="mode-control" class="composer-control" type="button" aria-haspopup="menu" aria-expanded="false"><i id="mode-control-icon" class="codicon codicon-comment-discussion" aria-hidden="true"></i><span class="composer-control-label">Mode</span><span id="mode-control-value" class="composer-control-value"></span><i class="codicon codicon-chevron-down"></i></button>
              <div id="mode-menu" class="composer-popover" role="menu" hidden></div>
            </div>
            <div id="skills-menu-shell" class="composer-menu composer-skills">
              <button id="skills-control" class="composer-control" type="button" aria-haspopup="menu" aria-expanded="false"><i class="codicon codicon-library" aria-hidden="true"></i><span class="composer-control-label">Skills</span><span id="skills-control-value" class="composer-control-value">No skills</span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>
              <div id="skills-menu" class="composer-popover composer-skills-popover" role="menu" aria-label="Skills" hidden></div>
            </div>
            <div id="composer-extras" class="composer-extras">
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
            <button id="composer-more" class="composer-more icon-button" type="button" title="More options" aria-label="More options" aria-controls="composer-extras" aria-expanded="false"><i class="codicon codicon-ellipsis"></i></button>
          </div>
          <div class="action-actions">
            <button id="problems" class="problems-status" type="button" disabled>No problems</button>
            <button id="run" class="primary circular-action" type="button" title="Send" aria-label="Send"><i class="codicon codicon-arrow-up" aria-hidden="true"></i><span id="run-label" hidden>Send</span></button>
          </div>
        </div>
      </div>
    </section>

    </main>
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
