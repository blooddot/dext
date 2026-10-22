import * as vscode from "vscode";
import type { AgentProfile } from "../features/agents/contracts/agent.js";
import { resolveProjectEvidenceSettings } from "../features/project/contracts/projectEvidenceSettings.js";
import type { ProjectWorkspaceSettings } from "../features/project/contracts/projectSettings.js";
import { ArchifyAdapter } from "../features/project/host/diagrams/archifyAdapter.js";
import { ProjectDiagramAdapterRegistry } from "../features/project/host/diagrams/projectDiagramRegistry.js";
import type { ProjectAiProvider } from "../features/project/host/generation/projectAiGeneration.js";
import { isExcludedProjectEvidencePath, isProjectEvidencePath } from "../features/project/host/generation/projectAiGeneration.js";
import type { ProjectStore } from "../features/project/host/persistence/projectStore.js";
import { ProjectEditorProvider } from "../features/project/host/projectEditorProvider.js";
import { createProjectPanelDataSource, discoverArchifyRepository, effectiveProjectEvidenceSettings, readProjectEvidence as readBoundedProjectEvidence, readStructureIndexEvidence } from "../features/project/host/projectPanelDataSource.js";
import type { ProjectInitializationProgressListener } from "../features/project/host/projectService.js";
import { searchProjectReferences } from "../features/project/knowledge/projectContext.js";
import type { ProjectReferenceCandidate } from "../features/project/knowledge/projectReference.js";
import { PROJECT_PANEL_PAGES, type ProjectPanelPage } from "../features/project/presentation/projectPanel.js";
import type { VscodeWebviewPanelLike, EditorTabManager } from "../platform/editor-tabs/editorTabManager.js";
import { wrapVscodeWebviewPanel, type EditorTabPanelHandle } from "../platform/editor-tabs/editorTabManager.js";
import type { EditorTabRestorer } from "../platform/editor-tabs/editorTabSerializer.js";
import { createEditorTabState, restoreEditorTabState } from "../platform/editor-tabs/editorTabState.js";
import { EDITOR_TAB_VIEW_TYPES } from "../platform/editor-tabs/editorTabTypes.js";
function isProjectPanelPage(value: string | undefined): value is ProjectPanelPage {
  return value !== undefined && (PROJECT_PANEL_PAGES as readonly string[]).includes(value);
}
export interface ProjectSetupOptions {
  context: vscode.ExtensionContext; folder: vscode.WorkspaceFolder; projectStore: ProjectStore; editorTabs: EditorTabManager; editorTabRestorer: EditorTabRestorer;
  editors: { project?: ProjectEditorProvider };
  renderEditorHtml(this: void, panel: VscodeWebviewPanelLike, body: string): string;
  aiProvider: ProjectAiProvider; agentProfiles(): readonly AgentProfile[];
  onWorkspaceSettingsChanged(settings: ProjectWorkspaceSettings): Promise<void>;
  setReferenceSource(source: { search(query: string): Promise<ProjectReferenceCandidate[]>; open(objectId: string): Promise<void> }): void;
}
export function setupProject(options: ProjectSetupOptions): ProjectEditorProvider {
  const { context, folder, projectStore, editorTabs, editorTabRestorer, editors, renderEditorHtml } = options;

  // Last-good diagram snapshots are persisted so they survive a window reload; the registry owns
  // validation and the size budget, this only moves the document.
  const diagramRegistry = new ProjectDiagramAdapterRegistry({
    load: () => projectStore.readDiagramHistoryState(),
    save: (state) => projectStore.writeDiagramHistoryState(state)
  });
  const archifyRoot = vscode.Uri.joinPath(context.extensionUri, "vendor", "project-diagrams", "archify").fsPath;
  diagramRegistry.register(new ArchifyAdapter(archifyRoot, () => discoverArchifyRepository(folder.uri)));
  context.subscriptions.push({ dispose: () => diagramRegistry.dispose() });
  options.setReferenceSource({
    search: async (query) => { const intent = await projectStore.readIntent(); return searchProjectReferences({ objects: await projectStore.readObjects(), query, ...(intent ? { intent } : {}) }); },
    open: async (objectId) => { await editors.project?.show("knowledge", objectId); }
  });
  const projectEvidenceInput = async () => {
    const [objects, intent, definition] = await Promise.all([
      projectStore.readObjects(),
      projectStore.readIntent(),
      projectStore.readDefinition()
    ]);
    if (!definition.evidence) throw new Error("Configure and save Evidence reading in Overview > Project settings before reading project sources.");
    return {
      // Read per run so a settings change applies to the next initialization or diagram.
      knowledge: { objects, ...(intent ? { intent } : {}) },
      limits: resolveProjectEvidenceSettings(effectiveProjectEvidenceSettings(definition)),
      structureAssetsPath: vscode.Uri.joinPath(context.extensionUri, "dist", "structure-index").fsPath,
      structureCachePath: vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, "project-structure.json").fsPath
    };
  };
  const readProjectEvidence = async (
    request: { requirement?: string; preferredPaths?: readonly string[]; modulePaths?: readonly string[] },
    signal: AbortSignal,
    onProgress: ProjectInitializationProgressListener
  ) => {
    const { knowledge, limits, structureAssetsPath, structureCachePath } = await projectEvidenceInput();
    return readBoundedProjectEvidence(
      folder.uri,
      knowledge,
      {
        ...(request.requirement ? { requirement: request.requirement } : {}),
        ...(request.preferredPaths ? { preferredPaths: request.preferredPaths } : {}),
        ...(request.modulePaths ? { modulePaths: request.modulePaths } : {}),
        ...limits, structureAssetsPath, structureCachePath
      },
      onProgress,
      signal
    );
  };
  const readStructureIndex = async (signal: AbortSignal, onProgress: ProjectInitializationProgressListener) => {
    const { knowledge, limits, structureAssetsPath, structureCachePath } = await projectEvidenceInput();
    return readStructureIndexEvidence(folder.uri, knowledge, { ...limits, structureAssetsPath, structureCachePath }, onProgress, signal);
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
      readStructureIndex,
      diagramRegistry,
      projectAiProvider: options.aiProvider,
      aiCli: options.agentProfiles().map((profile) => ({
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
      onWorkspaceSettingsChanged: async (settings) => {
        await options.onWorkspaceSettingsChanged(settings);
      }
    })
  });
  context.subscriptions.push({ dispose: () => editors.project?.dispose() });
  context.subscriptions.push(
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

  return editors.project;
}
