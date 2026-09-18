import * as vscode from "vscode";
import { DextApiDefinitionProvider, DextBuiltinApisContentProvider, DextBuiltinTypesContentProvider, DextMcpApisContentProvider } from "./vscodeApiDefinitions.js";
import { DextApplication } from "./application.js";
import { redactedMcpUrl } from "./core/mcpRegistry.js";
import { DextApiDiagnostics } from "./vscodeApiDiagnostics.js";
import { DextSidebarProvider } from "./sidebarProvider.js";
import { DEFAULT_HISTORY_LIMITS, DextHistoryStore } from "./historyStore.js";
import type { DextHistoryRecord, DextHistorySession } from "./historyStore.js";
import { DextHistoryPanel } from "./historyEditorProvider.js";
import { DextConversationPreferences } from "./conversationPreferences.js";
import type { HistorySortOrder } from "./conversationPreferences.js";
import { conversationMarkdown, conversationTitle, historyTurnMarkdown, historyTurnTitle } from "./historyRender.js";
import { DELETE_CONFIRMATION_DETAIL, TURN_DELETE_CONFIRMATION, TURN_RETRY_CONFIRMATION } from "./turnPresentation.js";
import { recordWorkflow } from "./core/workflowRecorder.js";
import { DextCompletionHost } from "./vscodeCompletionHost.js";
import { DextCompletionContext } from "./vscodeCompletionContext.js";
import { DextCompletionEvaluation } from "./vscodeCompletionEvaluation.js";
import { CompletionMemoryEpochs } from "./core/completionMemory.js";
import { DextSelectionActions } from "./vscodeSelectionActions.js";
import type { SelectionTarget } from "./vscodeAttachments.js";
import {
  configureCompletionModel,
  diagnoseCompletion,
  openCompletionMenu,
  setCompletionApiKey,
  testCompletionModel,
  type CompletionDiagnoseOptions
} from "./vscodeCompletionSetup.js";
import {
  dextSemanticTokens,
  DEXT_SEMANTIC_TOKEN_MODIFIERS,
  DEXT_SEMANTIC_TOKEN_TYPES
} from "./dextSemanticTokens.js";
import { pythonHoverCode } from "./vscodeHover.js";
import { EditorTabManager, createVscodeEditorTabHost, wrapVscodeWebviewPanel, type EditorTabPanelHandle } from "./editorTabManager.js";
import { EditorTabRestorer } from "./editorTabSerializer.js";
import { EDITOR_TAB_VIEW_TYPES } from "./editorTabTypes.js";
import { createEditorTabState, restoreEditorTabState } from "./editorTabState.js";
import { ProjectEditorProvider } from "./projectEditorProvider.js";
import { PROJECT_PANEL_PAGES, type ProjectPanelPage } from "./webview/projectPanel.js";
import { ApiEditorProvider } from "./apiEditorProvider.js";
import { GlobalResourcesEditorProvider } from "./globalResourcesEditorProvider.js";
import { createSidebarResourceDataSource, renderResourceError } from "./resourceDocuments.js";
import type { ResourceScope } from "./resourceSession.js";
import { parseEditorTabKey } from "./editorTabTypes.js";
import type { VscodeWebviewPanelLike } from "./editorTabManager.js";
import { ProjectStore } from "./projectStore.js";
import { searchProjectReferences } from "./core/projectContext.js";
import { VscodeProjectFileHost, createProjectPanelDataSource, discoverArchifyRepository, legacyScanInclude, readWorkspaceEvidence } from "./vscodeProjectHost.js";
import { projectAiLimits, projectEvidenceLimits } from "./projectAiLimits.js";
import { renderEditorTabHtml } from "./editorTabHtml.js";
import { ProjectDiagramAdapterRegistry } from "./core/projectDiagramRegistry.js";
import { ArchifyAdapter } from "./core/archifyAdapter.js";
import { isExcludedProjectEvidencePath, isProjectEvidencePath } from "./core/projectAiGeneration.js";
import type { ProjectInitializationProgressListener } from "./projectService.js";
let activeApplication: DextApplication | undefined;

/** Narrows a restored page to one the Project tab can actually render. */
function isProjectPanelPage(value: string | undefined): value is ProjectPanelPage {
  return value !== undefined && (PROJECT_PANEL_PAGES as readonly string[]).includes(value);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const application = new DextApplication(context.globalState, context.secrets, context.globalStorageUri);
  activeApplication = application;
  context.subscriptions.push({ dispose: () => { void application.dispose(); } });
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) application.runtime.setWorkspaceRoot(folder.uri.fsPath);
  application.runtime.setWorkspaceTrusted(vscode.workspace.isTrusted && folder?.uri.scheme === "file");
  await application.reload();
  const apiDiagnostics = new DextApiDiagnostics(() => (vscode.workspace.workspaceFolders ?? [])
    .filter((workspace) => workspace.uri.scheme === "file")
    .map((workspace) => ({
      workspace: workspace.uri.fsPath,
      apiDirs: vscode.workspace.getConfiguration("dext", workspace.uri).get<string[]>("apiDirs", []),
      globalStorage: context.globalStorageUri.fsPath,
      readSettings: false
    })));
  application.onApiReload = () => apiDiagnostics.schedule();
  context.subscriptions.push(apiDiagnostics);
  // Conversation history belongs to the active workspace. Using globalState
  // here makes every project share the same sessions, so reopening VS Code (or
  // switching projects) can restore a conversation from an unrelated project.
  // workspaceState survives extension/window reloads while remaining scoped to
  // the current workspace.
  const history = new DextHistoryStore(context.workspaceState, () => {
    const configuration = vscode.workspace.getConfiguration("dext");
    return {
      maxTurns: configuration.get<number>("history.maxTurns", DEFAULT_HISTORY_LIMITS.maxTurns),
      maxOutputLength: configuration.get<number>(
        "history.maxOutputLength",
        DEFAULT_HISTORY_LIMITS.maxOutputLength
      )
    };
  });
  const preferences = new DextConversationPreferences(context.workspaceState);
  const historyPanel = new DextHistoryPanel(context.extensionUri, history, preferences, application.storage);
  const sidebar = new DextSidebarProvider(context.extensionUri, application, history, preferences);
  // Unified editor tabs: Project, API, Global Resources, and History all go through one manager so
  // a stable key can never open twice, whichever recovery path runs first.
  const editors: {
    project?: ProjectEditorProvider;
    api?: ApiEditorProvider;
    globalResources?: GlobalResourcesEditorProvider;
  } = {};
  const renderEditorHtml = (panel: VscodeWebviewPanelLike, body: string): string => {
    const webview = (panel as vscode.WebviewPanel).webview;
    // Only the Project diagrams page embeds the sandboxed Archify viewer; its srcdoc inherits this
    // policy, so the relaxed frame/font/image sources stay scoped to that document.
    return renderEditorTabHtml(body,
      webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "editorTabs.css")).toString(),
      webview.cspSource,
      { embedFrames: body.includes("data-diagram-frame") });
  };
  const editorTabs = new EditorTabManager(
    createVscodeEditorTabHost(vscode.window, { localResourceRoots: [context.extensionUri], renderHtml: renderEditorHtml }),
    (key, message) => {
      const kind = parseEditorTabKey(key)?.kind;
      const provider = kind === "project" ? editors.project : kind === "api" ? editors.api : kind === "globalResources" ? editors.globalResources : undefined;
      void reportCommandError(() => provider?.handleMessage(key, message) ?? Promise.resolve());
    }
  );
  const editorTabRestorer = new EditorTabRestorer(editorTabs);
  context.subscriptions.push({ dispose: () => editorTabs.dispose() });
  const projectHost = folder?.uri.scheme === "file" ? new VscodeProjectFileHost(folder.uri) : undefined;
  if (projectHost && folder) {
    const projectStore = new ProjectStore(projectHost);
    // Last-good diagram snapshots are persisted so they survive a window reload; the registry owns
    // validation and the size budget, this only moves the document.
    const diagramRegistry = new ProjectDiagramAdapterRegistry({
      load: () => projectStore.readDiagramHistoryState(),
      save: (state) => projectStore.writeDiagramHistoryState(state)
    });
    const archifyRoot = vscode.Uri.joinPath(context.extensionUri, "vendor", "project-diagrams", "archify").fsPath;
    diagramRegistry.register(new ArchifyAdapter(archifyRoot, () => discoverArchifyRepository(folder.uri)));
    context.subscriptions.push({ dispose: () => diagramRegistry.dispose() });
    // Freezing the Review preset at send time needs a synchronous read, so the last known project
    // definition is cached as soon as the store is first read.
    void projectStore.readDefinition().catch(() => undefined);
    sidebar.setProjectPresetSource(() => projectStore.presetDefault());
    sidebar.setProjectReferenceSource({
      search: async (query) => { const intent = await projectStore.readIntent(); return searchProjectReferences({ objects: await projectStore.readObjects(), query, ...(intent ? { intent } : {}) }); },
      open: async (objectId) => { await editors.project?.show("knowledge", objectId); }
    });
    const readProjectEvidence = async (
      request: { requirement?: string },
      signal: AbortSignal,
      onProgress: ProjectInitializationProgressListener
    ) => {
      const [objects, intent, definition] = await Promise.all([
        projectStore.readObjects(),
        projectStore.readIntent(),
        projectStore.readDefinition()
      ]);
      const limits = projectEvidenceLimits();
      // The removed scanner profile still names the folders this reader cares about, so it keeps
      // acting as the evidence scope until `dext.project.evidenceInclude` says otherwise.
      const retiredRoots = limits.include.length ? [] : legacyScanInclude(definition);
      return readWorkspaceEvidence(
        folder.uri,
        { objects, ...(intent ? { intent } : {}) },
        {
          // Read per run so a settings change applies to the next initialization or diagram.
          ...(request.requirement ? { requirement: request.requirement } : {}),
          ...limits,
          ...(retiredRoots.length ? { include: retiredRoots } : {})
        },
        onProgress,
        signal
      );
    };
    const openProjectEvidence = async (path: string, line?: number): Promise<void> => {
      // Stable-ID evidence navigation: the host validates the relative path before opening.
      if (!isProjectEvidencePath(path) || isExcludedProjectEvidencePath(path)) return;
      const uri = vscode.Uri.joinPath(folder.uri, ...path.split("/").filter(Boolean));
      if (!vscode.workspace.getWorkspaceFolder(uri)) return;
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      if (line && line > 0) {
        const position = new vscode.Position(Math.min(line - 1, Math.max(0, document.lineCount - 1)), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position));
      }
    };
    editors.project = new ProjectEditorProvider({
      manager: editorTabs,
      restorer: editorTabRestorer,
      dataSource: createProjectPanelDataSource({
        name: folder.name,
        root: ".",
        rootUri: folder.uri,
        store: {
          readObjects: () => projectStore.readObjects(),
          readArchitecture: () => projectStore.readArchitecture(),
          readDefinition: () => projectStore.readDefinition(),
          writeDefinition: (next, expectedVersion) => projectStore.writeDefinition(next, expectedVersion),
          readIntent: () => projectStore.readIntent(),
          writeIntent: (intent) => projectStore.writeIntent(intent),
          readDiagrams: () => projectStore.readDiagrams(),
          writeDiagram: (diagram) => projectStore.writeDiagram(diagram),
          readInitialization: () => projectStore.readInitialization(),
          readEvidenceSummary: () => projectStore.readEvidenceSummary(),
          writeEvidenceSummary: (summary) => projectStore.writeEvidenceSummary(summary)
        },
        readEvidence: readProjectEvidence,
        diagramRegistry,
        projectAiProvider: application.projectAiProvider(),
        aiCli: application.agentProfiles().map((profile) => ({
          id: profile.id,
          label: profile.label,
          models: profile.modelOptions?.length
            ? profile.modelOptions.map((model) => ({
              id: model.id,
              label: model.label,
              ...(model.group ? { group: model.group } : {}),
              ...(model.reasoningEfforts.length ? { reasoningEfforts: model.reasoningEfforts } : {}),
              ...(model.speedTiers.length ? { speedTiers: model.speedTiers } : {}),
              ...(model.serviceTiers.length ? { serviceTiers: model.serviceTiers } : {})
            }))
            : profile.models.map((id) => ({ id, label: id }))
        })),
        openEvidence: openProjectEvidence,
        projectAiLimits: () => projectAiLimits()
      })
    });
    context.subscriptions.push({ dispose: () => editors.project?.dispose() });
    context.subscriptions.push(
      // The adoption bridge: adopting a Knowledge draft writes one long-term object and navigates
      // to it. Accepting the code review stays a separate action and never writes project knowledge.
      (() => {
        sidebar.setReviewKnowledgeSink({
          load: async (objectId) => (await projectStore.readObjects()).find((object) => object.id === objectId),
          save: (object) => projectStore.writeObject(object),
          remove: (objectId) => projectStore.deleteObject(objectId),
          navigate: async (objectId) => { await editors.project?.show("knowledge", objectId); }
        });
        return { dispose: () => undefined };
      })(),
      vscode.window.registerWebviewPanelSerializer(EDITOR_TAB_VIEW_TYPES.project, {
        deserializeWebviewPanel: async (panel, state) => {
          // The page script persists its own state, so this is normally present. A tab saved by an
          // older build carries none: it is still adopted under the project key and rendered rather
          // than left blank, which is what the previous `return` on a non-opened outcome did.
          const provider = editors.project;
          const restored = restoreEditorTabState(state).state
            ?? (provider ? createEditorTabState(provider.key, { page: "overview" }) : undefined);
          if (!provider || !restored) { panel.dispose(); return; }
          const adopted: EditorTabPanelHandle = wrapVscodeWebviewPanel(panel, {
            // The callback belongs to this panel only; a panel `adopt` disposed must not close the live tab.
            onDispose: () => { editorTabs.closeIfCurrent(restored.key, adopted); },
            onMessage: (message) => { editorTabs.receive(restored.key, message); }
          }, renderEditorHtml);
          const outcome = editorTabRestorer.adoptRestored(restored, () => adopted);
          if (outcome.status === "invalid") { adopted.dispose(); return; }
          if (outcome.status !== "opened") return;
          await provider.show(isProjectPanelPage(restored.page) ? restored.page : "overview");
        }
      })
    );
  }
  const textDecoderForResources = new TextDecoder();
  const resourceDataSource = createSidebarResourceDataSource({
    state: () => application.state(),
    readFile: async (entry) => {
      const path = entry.source.path;
      if (!path) return undefined;
      try {
        return textDecoderForResources.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path)));
      } catch {
        // A missing resource file falls back to the generated summary.
        return undefined;
      }
    }
  });
  const resourceCommandFor = (scope: ResourceScope) =>
    async (command: string, payload: { id?: string; kind?: string; path?: string }): Promise<void> => {
      if (command.endsWith(".newResource")) {
        const kind = payload.kind;
        if (kind !== "api" && kind !== "mcp" && kind !== "rule" && kind !== "skill") {
          throw new Error(`Unknown resource type '${payload.kind ?? ""}'.`);
        }
        await sidebar.editResource(kind, scope);
        return;
      }
      if (command.endsWith(".openResourceSource")) {
        if (!payload.path) throw new Error("This resource has no readable source file.");
        await vscode.window.showTextDocument(vscode.Uri.file(payload.path));
        return;
      }
      if (command.endsWith(".insertResourceReference")) {
        const entry = payload.id ? await resourceDataSource.definition(payload.id) : undefined;
        if (!entry) throw new Error("Select a resource before inserting a reference.");
        if (entry.entry.kind === "api") sidebar.insertReferences([`${entry.entry.name}()`]);
        else await sidebar.editResource(entry.entry.kind, entry.entry.scope);
        return;
      }
      await vscode.commands.executeCommand(command);
    };
  editors.api = new ApiEditorProvider({
    manager: editorTabs,
    restorer: editorTabRestorer,
    dataSource: resourceDataSource,
    scope: "project",
    onCommand: resourceCommandFor("project")
  });
  editors.globalResources = new GlobalResourcesEditorProvider({
    manager: editorTabs,
    restorer: editorTabRestorer,
    dataSource: resourceDataSource,
    scope: "global",
    availableScopes: () => application.state().resourceRoots?.project ? ["global", "project"] : ["global"],
    onCommand: (command, payload) => resourceCommandFor(payload.scope === "project" ? "project" : "global")(command, payload)
  }, ["api", "mcp", "rule", "skill"]);
  const resourceSerializer = (provider: () => ApiEditorProvider | GlobalResourcesEditorProvider | undefined) => ({
    deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown): Promise<void> => {
      const active = provider();
      const restoredState = restoreEditorTabState(state).state;
      const resourceId = restoredState?.resourceId ?? parseEditorTabKey(restoredState?.key ?? "")?.resourceId;
      // Migrate old API detail tabs into the single API browser when restoring a window. The browser
      // keeps one stable key, so a panel restored without usable state can still be adopted.
      const key = active instanceof ApiEditorProvider ? active.listTabKey : restoredState?.key ?? "";
      if (!active || !key) { panel.dispose(); return; }
      const adopted: EditorTabPanelHandle = wrapVscodeWebviewPanel(panel as unknown as VscodeWebviewPanelLike, {
        onDispose: () => { editorTabs.closeIfCurrent(key, adopted); },
        onMessage: (message) => { editorTabs.receive(key, message); }
      }, renderEditorHtml);
      const outcome = editorTabRestorer.adoptRestored({ ...(restoredState ?? {}), key }, () => adopted);
      if (outcome.status === "invalid") { adopted.dispose(); return; }
      if (outcome.status !== "opened") return;
      try {
        if (resourceId) await active.showDetail(resourceId);
        else await active.showList();
      } catch (error) {
        // A resource that disappeared keeps its stable key and shows a recoverable error.
        adopted.setHtml?.(renderResourceError(resourceId ?? key, error instanceof Error ? error.message : String(error)));
      }
    }
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("dext.openProject", () => reportCommandError(async () => {
      if (editors.project) await editors.project.show("overview");
      else await vscode.window.showInformationMessage("Open a local project folder to use Dext Project.");
    })),
    vscode.commands.registerCommand("dext.viewApis", () =>
      reportCommandError(() => editors.api?.showList() ?? Promise.resolve(undefined))
    ),
    vscode.commands.registerCommand("dext.viewResources", () =>
      reportCommandError(() => editors.globalResources?.showList() ?? Promise.resolve(undefined))
    ),
    vscode.commands.registerCommand("dext.openResourceSource", (path?: string) =>
      reportCommandError(() => resourceCommandFor("project")("dext.openResourceSource", typeof path === "string" ? { path } : {}))
    ),
    vscode.commands.registerCommand("dext.insertResourceReference", (id?: string) =>
      reportCommandError(() => resourceCommandFor("project")("dext.insertResourceReference", typeof id === "string" ? { id } : {}))
    ),
    vscode.commands.registerCommand("dext.editResource", (kind?: string, scope?: string) =>
      reportCommandError(() => sidebar.editResource(
        (kind === "api" || kind === "mcp" || kind === "rule" || kind === "skill") ? kind : "rule",
        scope === "global" ? "global" : "project"
      ))
    ),
    vscode.window.registerWebviewPanelSerializer(EDITOR_TAB_VIEW_TYPES.api, resourceSerializer(() => editors.api)),
    vscode.window.registerWebviewPanelSerializer(EDITOR_TAB_VIEW_TYPES.globalResources, resourceSerializer(() => editors.globalResources))
  );
  if (folder?.uri.scheme === "file") {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, ".dext/mcp/**/*.jsonc"));
    const refreshMcpManifests = async (): Promise<void> => {
      await application.reload();
      await sidebar.refresh();
    };
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(() => { void refreshMcpManifests(); }),
      watcher.onDidChange(() => { void refreshMcpManifests(); }),
      watcher.onDidDelete(() => { void refreshMcpManifests(); })
    );
  }
  const reportCommandError = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  const reportInvalidAgentCliConfiguration = async (): Promise<void> => {
    const invalid = application.invalidAgentCliIds();
    if (!invalid.length) return;
    await vscode.window.showErrorMessage(
      `Unsupported Dext agent CLI profile${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}. `
      + "Supported values: codex, claude, deepseek-harness."
    );
  };
  await reportInvalidAgentCliConfiguration();
  const focusSidebar = async (): Promise<void> => {
    await vscode.commands.executeCommand("dext.sidebar.focus");
  };
  const activeDextEditor = (): boolean => vscode.window.activeTextEditor?.document.languageId === "dext-api";
  // The History and sidebar webviews pass the right-clicked element's context
  // object.
  interface ConversationContext {
    sessionId?: string;
    turnId?: string;
    dextTabTitle?: string;
  }
  const historySession = (context?: ConversationContext): DextHistorySession => {
    const session = context?.sessionId
      ? history.list(true).find((item) => item.id === context.sessionId)
      : undefined;
    if (!session) throw new Error("Conversation not found in Dext history.");
    return session;
  };
  const forkConversation = async (source: DextHistorySession, turns: readonly DextHistoryRecord[]): Promise<void> => {
    const forked = await history.fork(turns, source.providerSessions);
    // A fork of a conversation the user took the trouble to name would be hard
    // to recognize under a name derived from its first message.
    const name = preferences.title(source.id);
    if (name) await preferences.setTitle(forked.id, `${name} (fork)`);
    await sidebar.openConversation(forked);
    await focusSidebar();
    sidebar.showChat();
    historyPanel.refresh();
  };
  const renameConversation = async (sessionId: string, current: string): Promise<void> => {
    const name = await vscode.window.showInputBox({
      title: "Rename Dext conversation",
      prompt: "Leave the name empty to go back to the one taken from the first message.",
      value: current,
      ignoreFocusOut: true
    });
    if (name === undefined) return;
    await sidebar.renameConversation(sessionId, name);
    historyPanel.refresh();
  };
  /** Writes the recorded skeleton into `.dext/api` and opens it, because the file
   * is meant to be edited before it is trusted. A name already in use gets a
   * numbered suffix rather than overwriting an API someone else wrote. */
  const recordConversation = async (session: DextHistorySession): Promise<void> => {
    const target = vscode.workspace.workspaceFolders?.[0];
    if (!target || !application.isTrustedLocalWorkspace()) {
      throw new Error("Recording a conversation as a workflow requires a trusted local workspace.");
    }
    const recorded = recordWorkflow(session.turns);
    const directory = vscode.Uri.joinPath(target.uri, ".dext", "api");
    await vscode.workspace.fs.createDirectory(directory);
    let file = vscode.Uri.joinPath(directory, recorded.fileName);
    for (let suffix = 2; suffix < 100; suffix += 1) {
      try {
        await vscode.workspace.fs.stat(file);
      } catch {
        break;
      }
      file = vscode.Uri.joinPath(directory, `${recorded.apiId}_${suffix}.dx`);
    }
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(recorded.source));
    await application.reload();
    await sidebar.refresh();
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, { preview: false });
  };
  // A conversation tab may still be unsaved, so it is addressed by id rather
  // than looked up in history.
  const tabSessionId = (context?: ConversationContext): string => {
    if (!context?.sessionId) throw new Error("Conversation tab not found.");
    return context.sessionId;
  };
  const updateHistoryContext = (): void => {
    void vscode.commands.executeCommand("setContext", "dext.historyNewestFirst", preferences.sortOrder() === "newest");
    void vscode.commands.executeCommand("setContext", "dext.historyFavoritesOnly", preferences.favoritesOnly());
    void vscode.commands.executeCommand("setContext", "dext.historyArchivedOnly", preferences.archivedOnly());
  };
  const setSortOrder = async (order: HistorySortOrder): Promise<void> => {
    await preferences.setSortOrder(order);
    updateHistoryContext();
    historyPanel.refresh();
  };
  const setFavoritesOnly = async (favoritesOnly: boolean): Promise<void> => {
    await preferences.setFavoritesOnly(favoritesOnly);
    updateHistoryContext();
    historyPanel.refresh();
  };
  const setArchivedOnly = async (archivedOnly: boolean): Promise<void> => {
    await preferences.setArchivedOnly(archivedOnly);
    updateHistoryContext();
    historyPanel.refresh();
  };
  const setFavorite = async (context: ConversationContext | undefined, favorite: boolean): Promise<void> => {
    await preferences.setFavorite(historySession(context).id, favorite);
    historyPanel.refresh();
  };
  const updateTrustContext = (): void => {
    void vscode.commands.executeCommand("setContext", "dext.workspaceTrusted", vscode.workspace.isTrusted);
  };
  const openWorkspaceTrust = async (): Promise<void> => {
    const available = await vscode.commands.getCommands(true);
    const command = [
      "workbench.trust.manage",
      "workbench.action.manageTrustedUris",
      "workbench.action.configureWorkspaceTrust",
      "workbench.action.manageTrust"
    ].find((candidate) => available.includes(candidate));
    if (command) {
      await vscode.commands.executeCommand(command);
      return;
    }
    await vscode.window.showInformationMessage(
      "Use the Command Palette to run 'Workspaces: Manage Workspace Trust'."
    );
  };
  const pickMcpCredentialServer = async (verifyOnly = false): Promise<string | undefined> => {
    if (!application.isTrustedLocalWorkspace()) {
      await vscode.window.showErrorMessage("MCP credentials require a trusted local workspace.");
      return undefined;
    }
    if (verifyOnly) {
      // Verification is a read-only handshake, so any configured server is a
      // candidate — including stdio and servers a rejected manifest dropped.
      const choices = application.mcpServerChoices();
      if (!choices.length) {
        await vscode.window.showErrorMessage("No MCP servers are configured in .dext/mcp.");
        return undefined;
      }
      const picked = await vscode.window.showQuickPick(
        choices.map((choice) => ({
          label: choice.name,
          description: choice.reason ? "rejected configuration" : choice.detail
        })),
        { placeHolder: "Choose an MCP server to verify" }
      );
      if (!picked) return undefined;
      const choice = choices.find((candidate) => candidate.name === picked.label);
      if (choice?.reason) {
        await vscode.window.showErrorMessage(`MCP server '${picked.label}' was rejected: ${choice.reason}`);
        return undefined;
      }
      return picked.label;
    }
    const credential = await vscode.window.showQuickPick([
      { label: "HTTP · Bearer", description: "Send Authorization: Bearer ...", transport: "http" as const, credentialKind: "bearer" as const },
      { label: "HTTP · Query parameter", description: "Send the token as a URL query parameter (?name=...); the configured URL stays credential-free", transport: "http" as const, credentialKind: "query" as const },
      { label: "stdio · Environment token", description: "Inject the token into the configured child-process environment variable", transport: "stdio" as const, credentialKind: "token" as const }
    ], { placeHolder: "Choose MCP credential type" });
    if (!credential) return undefined;
    const servers = application.mcpCredentialServers(credential.transport, credential.credentialKind);
    if (!servers.length) {
      await vscode.window.showErrorMessage(`No ${credential.label} MCP servers are configured in .dext/mcp.`);
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      servers.map((server) => ({
        label: server.name,
        description: server.transport === "http" ? redactedMcpUrl(server) : `${server.command} ${(server.args ?? []).join(" ")}`
      })),
      { placeHolder: `Choose an MCP server (${credential.label})` }
    );
    return picked?.label;
  };
  updateTrustContext();
  updateHistoryContext();
  const completionContext = new DextCompletionContext((uri) => application.completionSettings(uri));
  const completionEpochs = new CompletionMemoryEpochs(vscode.Uri.joinPath(context.globalStorageUri, "completion-memory-generations").fsPath);
  const completionHost = new DextCompletionHost({
    settings: (uri) => application.completionSettings(uri),
    apiKey: () => application.completionApiKey(),
    context: completionContext,
    memoryStore: context.workspaceState,
    memoryEpochs: completionEpochs,
  });
  const epochListener = completionEpochs.onChange(() => completionHost.refresh());
  context.subscriptions.push(completionEpochs, { dispose: epochListener });
  context.subscriptions.push(completionContext);
  const completionDiagnostics = vscode.window.createOutputChannel("Dext Completion");
  const completionEvaluation = new DextCompletionEvaluation({
    settings: (uri) => application.completionSettings(uri),
    scope: (field, uri) => application.completionSettingScope(field, uri),
    apiKey: () => application.completionApiKey(),
    credentialStatus: () => application.completionCredentialStatus(),
    output: completionDiagnostics
  });
  context.subscriptions.push(completionEvaluation);
  // A leftover `dext.completion` object shadows the individual settings, so it
  // is cleared before the first keystroke rather than on next launch. It only
  // does anything the first time, in the first window to run it.
  void application.migrateCompletionSettings()
    .then((migrated) => {
      if (migrated) completionHost.refresh();
    })
    .catch(() => {
      // A read-only settings file is not a reason to fail activation.
    });
  const completionSetup: CompletionDiagnoseOptions = {
    evaluate: async () => { await completionEvaluation.run(); },
    clearMemory: () => completionHost.clearMemory(),
    memoryStatus: () => JSON.stringify(completionHost.memoryReport()),
    report: () => completionHost.report(),
    probe: (document, position) => completionHost.probe(document, position),
    scope: (field) => application.completionSettingScope(field, vscode.window.activeTextEditor?.document.uri),
    settings: () => application.completionSettings(vscode.window.activeTextEditor?.document.uri),
    writeSettings: (patch) => application.writeCompletionSettings(patch),
    apiKey: () => application.completionApiKey(),
    setApiKey: (value) => application.setCompletionApiKey(value),
    clearApiKey: () => application.clearCompletionApiKey(),
    verify: (settings, apiKey) => completionHost.verify(settings, apiKey),
    suspended: () => completionHost.suspended,
    toggle: () => completionHost.toggle(),
    refresh: () => completionHost.refresh()
  };
  const semanticLegend = new vscode.SemanticTokensLegend(
    [...DEXT_SEMANTIC_TOKEN_TYPES],
    [...DEXT_SEMANTIC_TOKEN_MODIFIERS]
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DextSidebarProvider.viewType, sidebar),
    historyPanel,
    vscode.commands.registerCommand("dext.openHistory", () => historyPanel.showInActiveEditor()),
    vscode.commands.registerCommand("dext.history.continueConversation", (context?: ConversationContext) =>
      reportCommandError(async () => {
        const session = historySession(context);
        const restored = { ...session };
        if (restored.archivedAt) delete restored.archivedAt;
        if (session.archivedAt) await history.setArchived(session.id, false);
        await sidebar.openConversation(restored);
        await focusSidebar();
        sidebar.showChat();
      })
    ),
    vscode.commands.registerCommand("dext.history.forkConversation", (context?: ConversationContext) =>
      reportCommandError(() => {
        const session = historySession(context);
        return forkConversation(session, session.turns);
      })
    ),
    vscode.commands.registerCommand("dext.history.forkFromTurn", (context?: ConversationContext) =>
      reportCommandError(() => {
        const session = historySession(context);
        const index = session.turns.findIndex((turn) => turn.id === context?.turnId);
        if (index === -1) throw new Error("Conversation turn not found.");
        return forkConversation(session, session.turns.slice(0, index + 1));
      })
    ),
    vscode.commands.registerCommand("dext.history.renameConversation", (context?: ConversationContext) =>
      reportCommandError(() => {
        const session = historySession(context);
        return renameConversation(session.id, preferences.title(session.id) ?? conversationTitle(session));
      })
    ),
    vscode.commands.registerCommand("dext.history.renameTurn", (context?: ConversationContext) =>
      reportCommandError(async () => {
        const session = historySession(context);
        const turn = session.turns.find((item) => item.id === context?.turnId);
        if (!turn) throw new Error("Conversation turn not found.");
        const name = await vscode.window.showInputBox({
          title: "Rename Dext turn",
          prompt: "Leave the name empty to restore the title from this turn's input.",
          value: historyTurnTitle(turn),
          ignoreFocusOut: true
        });
        if (name === undefined) return;
        await sidebar.renameTurn(session.id, turn.id, name);
        historyPanel.refreshTurnTitle(session.id, turn.id);
      })
    ),
    vscode.commands.registerCommand("dext.history.copyTurn", (context?: ConversationContext) =>
      reportCommandError(async () => {
        const session = historySession(context);
        const index = session.turns.findIndex((item) => item.id === context?.turnId);
        if (index === -1) throw new Error("Conversation turn not found.");
        await vscode.env.clipboard.writeText(historyTurnMarkdown(session.turns[index]!, index));
      })
    ),
    vscode.commands.registerCommand("dext.history.retryTurn", (context?: ConversationContext) =>
      reportCommandError(async () => {
        const session = historySession(context);
        const turn = session.turns.find((item) => item.id === context?.turnId);
        if (!turn) throw new Error("Conversation turn not found.");
        const confirmed = await vscode.window.showWarningMessage(TURN_RETRY_CONFIRMATION, { modal: true }, "Retry");
        if (confirmed !== "Retry") return;
        await sidebar.retryTurn(session.id, turn.id);
        historyPanel.refresh();
      })
    ),
    vscode.commands.registerCommand("dext.history.deleteTurn", (context?: ConversationContext) =>
      reportCommandError(async () => {
        const session = historySession(context);
        const turn = session.turns.find((item) => item.id === context?.turnId);
        if (!turn) throw new Error("Conversation turn not found.");
        if (!await confirmHistoryDeletion(TURN_DELETE_CONFIRMATION)) return;
        await sidebar.deleteTurn(turn.id, session.id);
        historyPanel.refresh();
      })
    ),
    vscode.commands.registerCommand("dext.history.editTurnInput", (context?: ConversationContext) =>
      reportCommandError(async () => {
        if (!context?.sessionId || !context.turnId) throw new Error("Conversation turn not found.");
        sidebar.editTurnInput(context.sessionId, context.turnId);
        await focusSidebar();
        sidebar.showChat();
      })
    ),
    vscode.commands.registerCommand("dext.history.recordWorkflow", (context?: ConversationContext) =>
      reportCommandError(() => recordConversation(historySession(context)))
    ),
    vscode.commands.registerCommand("dext.history.copyConversation", (context?: ConversationContext) =>
      reportCommandError(async () => {
        await vscode.env.clipboard.writeText(conversationMarkdown(historySession(context)));
      })
    ),
    vscode.commands.registerCommand("dext.history.deleteConversation", (context?: ConversationContext) =>
      reportCommandError(async () => {
        const session = historySession(context);
        if (!await confirmHistoryDeletion(
          `Delete this Dext conversation and its ${session.turns.length} turn${session.turns.length === 1 ? "" : "s"}?`
        )) return;
        // Detach the conversation before erasing it so a refused close leaves
        // history intact.
        await sidebar.forgetConversation(session.id);
        await history.remove(session.id);
        await preferences.forget(session.id);
        historyPanel.refresh();
      })
    ),
    vscode.commands.registerCommand("dext.history.archiveConversation", (context?: ConversationContext) =>
      reportCommandError(async () => {
        const session = historySession(context);
        await sidebar.forgetConversation(session.id);
        await history.setArchived(session.id, true);
        await preferences.setPinned(session.id, false);
        historyPanel.refresh();
      })
    ),
    vscode.commands.registerCommand("dext.history.unarchiveConversation", (context?: ConversationContext) =>
      reportCommandError(async () => {
        const session = historySession(context);
        await history.setArchived(session.id, false);
        historyPanel.refresh();
      })
    ),
    vscode.commands.registerCommand("dext.history.addFavorite", (context?: ConversationContext) =>
      reportCommandError(() => setFavorite(context, true))
    ),
    vscode.commands.registerCommand("dext.history.removeFavorite", (context?: ConversationContext) =>
      reportCommandError(() => setFavorite(context, false))
    ),
    vscode.commands.registerCommand("dext.history.showNewestFirst", () => setSortOrder("newest")),
    vscode.commands.registerCommand("dext.history.showOldestFirst", () => setSortOrder("oldest")),
    vscode.commands.registerCommand("dext.history.showFavoritesOnly", () => setFavoritesOnly(true)),
    vscode.commands.registerCommand("dext.history.showAllConversations", () => setFavoritesOnly(false)),
    vscode.commands.registerCommand("dext.history.showArchived", () => setArchivedOnly(true)),
    vscode.commands.registerCommand("dext.history.showActive", () => setArchivedOnly(false)),
    vscode.commands.registerCommand("dext.tab.renameConversation", (context?: ConversationContext) =>
      reportCommandError(() => renameConversation(tabSessionId(context), context?.dextTabTitle ?? ""))
    ),
    vscode.commands.registerCommand("dext.tab.pinConversation", (context?: ConversationContext) =>
      reportCommandError(() => sidebar.pinConversation(tabSessionId(context), true))
    ),
    vscode.commands.registerCommand("dext.tab.unpinConversation", (context?: ConversationContext) =>
      reportCommandError(() => sidebar.pinConversation(tabSessionId(context), false))
    ),
    vscode.commands.registerCommand("dext.tab.closeConversation", (context?: ConversationContext) =>
      reportCommandError(() => sidebar.closeTab(tabSessionId(context)))
    ),
    vscode.commands.registerCommand("dext.addMcp", () => sidebar.addMcp()),
    vscode.commands.registerCommand("dext.newConversation", () =>
      reportCommandError(() => sidebar.newConversation())
    ),
    vscode.commands.registerCommand("dext.focus", async () => {
      await vscode.commands.executeCommand("dext.sidebar.focus");
      sidebar.focusEditor();
    }),
    vscode.commands.registerCommand("dext.stopExecution", () =>
      reportCommandError(() => Promise.resolve(sidebar.stopExecution()))
    ),
    vscode.commands.registerCommand("dext.reloadMethods", async () => {
      await application.reload();
      await sidebar.refresh();
      // The reload already scheduled a check; an explicit reload also reveals
      // the details it produced instead of leaving one aggregate line behind.
      await apiDiagnostics.check(true);
    }),
    vscode.commands.registerCommand("dext.openWorkspaceTrust", openWorkspaceTrust),
    vscode.commands.registerCommand("dext.workspaceTrustedStatus", openWorkspaceTrust),
    vscode.commands.registerCommand("dext.workspaceUntrustedStatus", openWorkspaceTrust),
    vscode.commands.registerCommand("dext.setMcpAccessToken", () =>
      reportCommandError(async () => {
        const serverName = await pickMcpCredentialServer();
        if (!serverName) return;
        const token = await vscode.window.showInputBox({
          prompt: `Access token for MCP server '${serverName}'`,
          password: true,
          ignoreFocusOut: true
        });
        if (token === undefined) return;
        await application.setMcpAccessToken(serverName, token);
        try {
          const count = await application.discoverAndPersistMcpTools(serverName);
          await vscode.window.showInformationMessage(`Stored the token for '${serverName}' and discovered ${count} MCP tool${count === 1 ? "" : "s"}.`);
        } catch (error) {
          await vscode.window.showWarningMessage(`Stored the token for '${serverName}', but tool discovery failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    ),
    vscode.commands.registerCommand("dext.clearMcpAccessToken", () =>
      reportCommandError(async () => {
        const serverName = await pickMcpCredentialServer();
        if (!serverName) return;
        const confirmed = await vscode.window.showWarningMessage(
          `Clear the stored access token for MCP server '${serverName}'?`,
          { modal: true },
          "Clear"
        );
        if (confirmed !== "Clear") return;
        await application.clearMcpAccessToken(serverName);
        await vscode.window.showInformationMessage(`Cleared the access token for MCP server '${serverName}'.`);
      })
    ),
    vscode.commands.registerCommand("dext.completionMenu", () =>
      reportCommandError(() => openCompletionMenu(completionSetup))
    ),
    vscode.commands.registerCommand("dext.configureCompletionModel", () =>
      reportCommandError(() => configureCompletionModel(completionSetup))
    ),
    vscode.commands.registerCommand("dext.testCompletionModel", () =>
      reportCommandError(() => testCompletionModel(completionSetup))
    ),
    completionDiagnostics,
    vscode.commands.registerCommand("dext.evaluateCompletion", (kind?: "quality" | "adaptation" | "performance") => completionEvaluation.run(kind)),
    vscode.commands.registerCommand("dext.completionAccepted", (id: unknown) => { if (typeof id === "string") completionHost.accept(id); }),
    vscode.commands.registerCommand("dext.clearCompletionMemory", () => reportCommandError(() => completionHost.clearMemory())),
    vscode.commands.registerCommand("dext.diagnoseCompletion", () =>
      reportCommandError(() => diagnoseCompletion(completionSetup, completionDiagnostics))
    ),
    vscode.commands.registerCommand("dext.setCompletionApiKey", () =>
      reportCommandError(() => setCompletionApiKey(completionSetup))
    ),
    vscode.commands.registerCommand("dext.clearCompletionApiKey", () =>
      reportCommandError(async () => {
        await application.clearCompletionApiKey();
        completionHost.refresh();
        await vscode.window.showInformationMessage("Cleared the Dext completion API key.");
      })
    ),
    vscode.commands.registerCommand("dext.verifyMcpServer", () =>
      reportCommandError(async () => {
        const serverName = await pickMcpCredentialServer(true);
        if (!serverName) return;
        await application.verifyMcpServer(serverName);
        await vscode.window.showInformationMessage(`MCP server '${serverName}' is ready.`);
      })
    ),
    vscode.commands.registerCommand("dext.triggerSuggest", async () => {
      if (activeDextEditor()) {
        await vscode.commands.executeCommand("editor.action.triggerSuggest");
        return;
      }
      sidebar.triggerSuggest();
    }),
    vscode.commands.registerCommand("dext.triggerParameterHints", async () => {
      if (activeDextEditor()) {
        await vscode.commands.executeCommand("editor.action.triggerParameterHints");
        return;
      }
      sidebar.triggerParameterHints();
    }),
    vscode.commands.registerCommand("dext.addSelectionToChat", (target?: SelectionTarget) =>
      reportCommandError(async () => {
        await sidebar.addSelectionToChat(target);
        await focusSidebar();
        sidebar.showChat();
      })
    ),
    vscode.commands.registerCommand("dext.copySelectionWithContext", () =>
      reportCommandError(() => sidebar.copySelectionWithContext())
    ),
    vscode.commands.registerCommand("dext.copyTerminalSelectionWithContext", () =>
      reportCommandError(() => sidebar.copyTerminalSelectionWithContext())
    ),
    vscode.commands.registerCommand("dext.addFileToChat", (resource?: vscode.Uri) =>
      reportCommandError(async () => {
        await sidebar.addFileToChat(resource);
        await focusSidebar();
        sidebar.showChat();
      })
    ),
    vscode.commands.registerCommand("dext.setActivePlan", (resource?: vscode.Uri) =>
      reportCommandError(async () => {
        const uri = resource ?? vscode.window.activeTextEditor?.document.uri;
        if (!uri) throw new Error("Open a Dext plan file before setting it as active.");
        await sidebar.setActivePlanFromUri(uri);
        await focusSidebar();
        sidebar.showChat();
      })
    ),
    vscode.commands.registerCommand("dext.configureAgent", async () => {
      const profiles = application.agentProfiles();
      const picked = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
          label: profile.label,
          description: profile.command || "Command not configured",
          profile
        })),
        { placeHolder: "Choose an Agent profile" }
      );
      if (!picked) return;
      const command = await vscode.window.showInputBox({
        prompt: `CLI command for ${picked.profile.label}`,
        value: picked.profile.command,
        ignoreFocusOut: true
      });
      if (command === undefined) return;
      if (picked.profile.provider === "deepseek-harness") {
        application.updateAgentProfile({ ...picked.profile, command: command.trim() });
        try { await application.discoverHarnessModels(); }
        catch (error) { await vscode.window.showWarningMessage(`Harness settings saved; model discovery failed: ${String(error)}`); }
        await sidebar.refresh();
        return;
      }
      const models = await vscode.window.showInputBox({
        prompt: "Supported models, separated by commas; leave empty for CLI default",
        value: picked.profile.models.join(", "),
        ignoreFocusOut: true
      });
      if (models === undefined) return;
      application.updateAgentProfile({
        ...picked.profile,
        command: command.trim(),
        models: models.split(",").map((model) => model.trim()).filter(Boolean)
      });
      await sidebar.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      // A new API directory changes the registered API set, so this one has to
      // go through a full reload rather than a refresh.
      if (event.affectsConfiguration("dext.apiDirs")) {
        await application.reload();
        await sidebar.refresh();
        return;
      }
      if (
        event.affectsConfiguration("dext.diff.defaultView")
        || event.affectsConfiguration("dext.submitOnEnter")
      ) {
        await sidebar.refresh();
        return;
      }
      // Timeouts and the fan-out width take effect on the next turn without
      // reloading the API set, which would needlessly re-scan the workspace.
      if (
        event.affectsConfiguration("dext.agent.timeoutMs")
        || event.affectsConfiguration("dext.agent.idleTimeoutMs")
        || event.affectsConfiguration("dext.workflow.maxConcurrency")
      ) {
        application.applyTimeoutSettings();
        return;
      }
      // Cached completions were produced under the old configuration, and the
      // status bar advertises the model, so both are rebuilt.
      if (event.affectsConfiguration("dext.completion")) {
          completionHost.refresh();
                  return;
      }
      if (
        event.affectsConfiguration("dext.agentPermission")
        || event.affectsConfiguration("dext.agentCliArgs")
        || event.affectsConfiguration("dext.agentCli")
      ) {
        application.applyAgentPermissionSettings();
        application.refreshAgentProfiles();
        if (event.affectsConfiguration("dext.agentCli")) {
          await reportInvalidAgentCliConfiguration();
        }
        await sidebar.refresh();
        return;
      }
      if (
        event.affectsConfiguration("workbench.colorTheme")
        || event.affectsConfiguration("workbench.preferredDarkColorTheme")
        || event.affectsConfiguration("workbench.preferredLightColorTheme")
        || event.affectsConfiguration("workbench.preferredHighContrastColorTheme")
        || event.affectsConfiguration("workbench.preferredHighContrastLightColorTheme")
        || event.affectsConfiguration("window.autoDetectColorScheme")
        || event.affectsConfiguration("window.autoDetectHighContrast")
        || event.affectsConfiguration("editor.tokenColorCustomizations")
      ) {
        await sidebar.refresh();
        historyPanel.refresh();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(async () => {
      await sidebar.refresh();
      historyPanel.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      updateTrustContext();
      await application.reload();
      await sidebar.refresh();
    }),
    completionHost,
    // Every file document, with the exclusions applied inside the provider. A
    // `pattern` here would be matched against the absolute path, which is one
    // more thing that can quietly fail to match.
    vscode.languages.registerInlineCompletionItemProvider({ scheme: "file" }, completionHost),
    vscode.commands.registerCommand("dext.toggleCompletion", () => completionHost.toggle()),
    vscode.languages.registerCompletionItemProvider(
      { language: "dext-api", scheme: "file" },
      {
        provideCompletionItems(document, position) {
          const source = document.getText();
          const cursor = document.offsetAt(position);
          const relative = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
          const marker = ".dext/api/";
          const index = relative.indexOf(marker);
          const apiId = index >= 0 ? relative.slice(index + marker.length).replace(/\.dx$/i, "").replace(/\//g, ".") : undefined;
          return application.language.apiCompletions(source, cursor, apiId).map((candidate) => {
            const completion = new vscode.CompletionItem(
              candidate.label,
              candidate.kind === "namespace" ? vscode.CompletionItemKind.Module :
                candidate.kind === "method" ? vscode.CompletionItemKind.Function :
                  candidate.kind === "parameter" ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Value
            );
            completion.detail = candidate.detail;
            completion.insertText = candidate.insertText;
            if (candidate.sortText) completion.sortText = candidate.sortText;
            completion.range = new vscode.Range(document.positionAt(candidate.replaceStart), document.positionAt(candidate.replaceEnd));
            return completion;
          });
        }
      },
      ".",
      " "
    ),
    vscode.languages.registerDefinitionProvider(
      [{ language: "dext-api", scheme: "file" }, { scheme: "dext-types" }, { scheme: "dext-builtins" }, { scheme: "dext-mcp" }],
      new DextApiDefinitionProvider((id) => application.customApiSourcePath(id), application.registry)
    ),
    vscode.workspace.registerTextDocumentContentProvider("dext-types", new DextBuiltinTypesContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider("dext-builtins", new DextBuiltinApisContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider("dext-mcp", new DextMcpApisContentProvider(application.registry)),
    vscode.languages.registerHoverProvider(
      [{ language: "dext-api", scheme: "file" }, { scheme: "dext-types" }, { scheme: "dext-builtins" }],
      {
        provideHover(document, position) {
          const source = document.getText();
          const cursor = document.offsetAt(position);
          const hover = document.uri.scheme === "file"
            ? application.language.apiHover(source, cursor)
            : application.language.documentHover(source, cursor);
          if (!hover) return undefined;
          // Markdown bold renders signatures as plain text.  A Python fenced
          // block uses VS Code's built-in grammar, which is also what Dext's
          // .dx grammar inherits, so types, keywords and literals retain the
          // familiar editor colours in hovers.
          const contents = new vscode.MarkdownString();
          contents.appendCodeblock(pythonHoverCode(hover.label, hover.kind), "python");
          contents.appendMarkdown("\n\n");
          contents.appendText(hover.documentation);
          return new vscode.Hover(
            contents,
            new vscode.Range(document.positionAt(hover.rangeStart), document.positionAt(hover.rangeEnd))
          );
        }
      }
    ),
    vscode.languages.registerSignatureHelpProvider(
      { language: "dext-api", scheme: "file" },
      {
        provideSignatureHelp(document, position) {
          const source = document.getText();
          const signature = application.language.apiSignature(source, document.offsetAt(position));
          if (!signature) return undefined;
          const item = new vscode.SignatureInformation(signature.label, signature.documentation);
          item.parameters = signature.parameters.map((parameter) => new vscode.ParameterInformation(parameter.label, parameter.documentation));
          const result = new vscode.SignatureHelp();
          result.signatures = [item];
          result.activeSignature = 0;
          result.activeParameter = signature.activeParameter;
          return result;
        }
      },
      "(", ","
    ),
    vscode.languages.registerDocumentSemanticTokensProvider(
      [{ language: "dext-api", scheme: "file" }, { scheme: "dext-types" }, { scheme: "dext-builtins" }, { scheme: "dext-mcp" }],
      {
        provideDocumentSemanticTokens(document) {
          const builder = new vscode.SemanticTokensBuilder(semanticLegend);
          for (const token of dextSemanticTokens(document.getText())) {
            builder.push(
              new vscode.Range(document.positionAt(token.from), document.positionAt(token.to)),
              token.type,
              token.declaration ? ["declaration"] : []
            );
          }
          return builder.build();
        }
      },
      semanticLegend
    )
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/.dext/api/**/*.dx");
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadRunning = false;
  let reloadQueued = false;
  const reload = (): void => {
    reloadQueued = true;
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      if (reloadRunning) return;
      reloadRunning = true;
      reloadQueued = false;
      void application.reload()
        .then(() => sidebar.refresh())
        .finally(() => {
          reloadRunning = false;
          if (reloadQueued) reload();
        });
    }, 150);
  };
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher, sidebar, new DextSelectionActions());
}

/** All conversation deletion entry points use the same native warning dialog. */
async function confirmHistoryDeletion(message: string): Promise<boolean> {
  return await vscode.window.showWarningMessage(
    message,
    { modal: true, detail: DELETE_CONFIRMATION_DETAIL },
    "Delete"
  ) === "Delete";
}

export async function deactivate(): Promise<void> { await activeApplication?.dispose(); activeApplication = undefined; }
