import { editorTabKey } from "./editorTabTypes.js";
import { createEditorTabState } from "./editorTabState.js";
import { describeEditorTab, type EditorTabManager } from "./editorTabManager.js";
import type { EditorTabRestorer } from "./editorTabSerializer.js";
import { renderProjectPanel, type ProjectPanelData, type ProjectPanelPage } from "./webview/projectPanel.js";
import type { ProjectInitializationState } from "./projectService.js";
import type { ProjectPanelMessage } from "./vscodeProjectHost.js";

export interface ProjectEditorDataSource {
  load(): Promise<ProjectPanelData>;
  /** Host → webview messages (render results, generation progress, export status). */
  subscribe?(listener: (message: ProjectPanelMessage) => void): () => void;
  initialize?(): Promise<ProjectPanelData>;
  initialization?(): ProjectInitializationState;
  onInitializationChange?(listener: (state: ProjectInitializationState) => void): () => void;
  setAiCli?(cli?: string): Promise<void> | void;
  setAiModel?(model?: string): Promise<void> | void;
  setAiReasoning?(reasoningEffort?: string): Promise<void> | void;
  setAiSpeed?(speed?: string): Promise<void> | void;
  setProjectSettings?(settings: unknown, version: number): Promise<void>;
  setEvidenceSettings?(settings: unknown, version: number): Promise<void>;
  setWorkspaceSettings?(settings: unknown, version: number): Promise<void>;
  /** Renders one saved diagram by stable id; `refresh` distinguishes re-render from AI update. */
  renderDiagram?(diagramId: string, version?: number, options?: { refresh?: boolean }): Promise<void> | void;
  /** On-demand AI generation/update of one diagram; other diagrams and knowledge stay untouched. */
  generateDiagram?(request: { requirement: string; kind?: string; diagramId?: string }): Promise<void> | void;
  /** Host-owned saving of the exact rendered result (HTML artifact or live SVG serialization). */
  exportDiagram?(request: { diagramId: string; version?: number; format?: string; content?: string }): Promise<void> | void;
  /** Opens one evidence entry the clicked node declares; a card click alone never opens a file. */
  openDiagramEvidence?(diagramId: string, nodeId: string, path: string, line?: number): Promise<void> | void;
  /** Opens one file the last evidence record lists, so the reader can inspect what was read. */
  openEvidencePath?(path: string): Promise<void> | void;
  /** Cancels in-flight render/generation work when the page closes or the diagram changes. */
  cancelDiagramWork?(): void;
}

export interface ProjectEditorProviderOptions {
  manager: EditorTabManager;
  restorer: EditorTabRestorer;
  dataSource: ProjectEditorDataSource;
  /** Main workspace root. The first version keeps a single root. */
  scope?: string;
}

export interface ProjectEditorShowResult {
  key: string;
  created: boolean;
  page: ProjectPanelPage;
}

/**
 * Project editor tab. It exposes only Overview, Knowledge, and Diagrams; hooks and renderer
 * preference controls remain outside the project editor.
 */
export class ProjectEditorProvider {
  private readonly pages = new Map<string, ProjectPanelPage>();
  private focusObjectId: string | undefined;
  private initializing = false;
  private activePanel: ReturnType<EditorTabManager["open"]>["panel"] | undefined;
  private lastData: ProjectPanelData | undefined;
  private readonly unsubscribeMessages: (() => void) | undefined;
  private readonly unsubscribeInitialization: (() => void) | undefined;
  readonly key: string;

  constructor(private readonly options: ProjectEditorProviderOptions) {
    this.key = editorTabKey("project", options.scope ? { scope: options.scope } : {});
    this.unsubscribeInitialization = options.dataSource.onInitializationChange?.((state) => this.activePanel?.postMessage?.({ type: "projectInitializationProgress", state }));
    this.unsubscribeMessages = options.dataSource.subscribe?.((message) => this.activePanel?.postMessage?.(message));
  }

  get page(): ProjectPanelPage {
    return this.pages.get(this.key) ?? "overview";
  }

  private render(page: ProjectPanelPage, data: ProjectPanelData): string {
    // The page script persists this exact state so a reload restores the same page.
    const state = createEditorTabState(this.key, { page });
    return renderProjectPanel(page, data, {
      ...(this.focusObjectId ? { focusObjectId: this.focusObjectId } : {}),
      ...(state ? { state } : {})
    });
  }

  /** Opens a page. A focus id marks the long-term object an adopted suggestion wrote. */
  async show(page: ProjectPanelPage = "overview", focusObjectId?: string): Promise<ProjectEditorShowResult> {
    const previous = this.pages.get(this.key);
    if (previous && previous !== page) this.options.dataSource.cancelDiagramWork?.();
    this.pages.set(this.key, page);
    this.focusObjectId = focusObjectId;
    const data = await this.options.dataSource.load();
    this.lastData = data;
    const descriptor = describeEditorTab("project", this.key, "dext.project");
    const result = this.options.manager.open(descriptor);
    this.activePanel = result.panel;
    result.panel.setHtml?.(this.render(page, data));
    return { key: this.key, created: result.created, page };
  }

  /** Restores the last page selection through the shared restorer, avoiding a duplicate panel. */
  async restore(state: unknown): Promise<"opened" | "reused" | "skipped" | "invalid"> {
    const restored = createEditorTabState(this.key, { page: this.page });
    const outcome = this.options.restorer.restore(state ?? restored, "serializer");
    if (outcome.status === "opened" && outcome.key) {
      const data = await this.options.dataSource.load();
      this.lastData = data;
      const opened = this.options.manager.open(describeEditorTab("project", outcome.key, "dext.project"));
      this.activePanel = opened.panel;
      opened.panel.setHtml?.(this.render(this.page, data));
    }
    return outcome.status;
  }

  /** Releases message listeners and cancels diagram work when the tab is disposed. */
  dispose(): void {
    this.options.dataSource.cancelDiagramWork?.();
    this.unsubscribeMessages?.();
    this.unsubscribeInitialization?.();
    // Dropping the reference keeps a disposed panel from being posted to afterwards.
    this.activePanel = undefined;
  }

  private async publishDefinitionVersion(): Promise<void> {
    const data = await this.options.dataSource.load();
    this.lastData = data;
    if (data.overview.evidenceSettingsVersion !== undefined) this.activePanel?.postMessage?.({ type: "projectDefinitionVersion", version: data.overview.evidenceSettingsVersion });
  }

  /** Handles webview messages routed by the shared manager. */
  async handleMessage(key: string, message: unknown): Promise<void> {
    if (key !== this.key) return;
    const payload = message as {
      type?: unknown; page?: unknown; diagramId?: unknown; version?: unknown; kind?: unknown;
      requirement?: unknown; format?: unknown; content?: unknown; nodeId?: unknown; path?: unknown; line?: unknown; refresh?: unknown;
      cli?: unknown; model?: unknown; reasoningEffort?: unknown; speed?: unknown;
      settings?: unknown;
    };
    if (payload?.type === "projectSettings" && this.options.dataSource.setProjectSettings) {
      try {
        if (this.initializing) throw new Error("Wait for initialization to finish before saving settings.");
        if (typeof payload.version !== "number" || !Number.isInteger(payload.version) || payload.version < 0) throw new Error("Reopen Overview before saving settings.");
        await this.options.dataSource.setProjectSettings(payload.settings, payload.version);
        const data = await this.options.dataSource.load();
        this.lastData = data;
        this.activePanel?.postMessage?.({ type: "projectSettingsSaved", version: data.overview.workspaceSettingsVersion ?? data.overview.evidenceSettingsVersion });
      } catch (error) {
        this.activePanel?.postMessage?.({ type: "projectSettingsSaved", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (payload?.type === "projectWorkspaceSettings" && this.options.dataSource.setWorkspaceSettings) {
      try {
        if (this.initializing) throw new Error("Wait for initialization to finish before saving settings.");
        if (typeof payload.version !== "number" || !Number.isInteger(payload.version) || payload.version < 0) throw new Error("Reopen Overview before saving settings.");
        await this.options.dataSource.setWorkspaceSettings(payload.settings, payload.version);
        const data = await this.options.dataSource.load();
        this.lastData = data;
        this.activePanel?.postMessage?.({ type: "projectWorkspaceSettingsSaved", version: data.overview.workspaceSettingsVersion });
      } catch (error) {
        this.activePanel?.postMessage?.({ type: "projectWorkspaceSettingsSaved", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (payload?.type === "projectEvidenceSettings" && this.options.dataSource.setEvidenceSettings) {
      try {
        if (this.initializing) throw new Error("Wait for initialization to finish before saving settings.");
        if (typeof payload.version !== "number" || !Number.isInteger(payload.version) || payload.version < 0) throw new Error("Reopen Overview before saving settings.");
        await this.options.dataSource.setEvidenceSettings(payload.settings, payload.version);
        const data = await this.options.dataSource.load();
        this.lastData = data;
        this.activePanel?.postMessage?.({ type: "projectEvidenceSettingsSaved", version: data.overview.evidenceSettingsVersion });
      } catch (error) {
        this.activePanel?.postMessage?.({ type: "projectEvidenceSettingsSaved", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (payload?.type === "projectInitialize" && this.options.dataSource.initialize && !this.initializing) {
      this.initializing = true;
      // Start the task before awaiting it so a tab switch can immediately reload the running
      // snapshot. The running render is intentionally independent of the completion render.
      const task = this.options.dataSource.initialize();
      void task.catch(() => undefined);
      try {
        if (this.lastData) {
          const state = this.options.dataSource.initialization?.() ?? { ...this.lastData.overview.initialization, status: "running" as const, phase: "preparing" as const };
          const runningData = { ...this.lastData, overview: { ...this.lastData.overview, initialization: state } };
          this.activePanel?.setHtml?.(this.render(this.page, runningData));
        }
        const data = await task;
        const completedPanel = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
        this.activePanel = completedPanel.panel;
        this.lastData = data;
        completedPanel.panel.setHtml?.(this.render(this.page, data));
      } catch {
        // A failed run is represented by the persisted initialization snapshot. Keep the panel
        // usable and let the next click retry instead of leaving a rejected message promise behind.
        try {
          const data = await this.options.dataSource.load();
          const opened = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
          this.activePanel = opened.panel;
          this.lastData = data;
          opened.panel.setHtml?.(this.render(this.page, data));
        } catch {
          // Loading a failure snapshot is best effort.
        }
      } finally {
        this.initializing = false;
      }
      return;
    }
    if (payload?.type === "projectAiCli" && this.options.dataSource.setAiCli && !this.initializing) {
      await this.options.dataSource.setAiCli(typeof payload.cli === "string" && payload.cli ? payload.cli : undefined);
      await this.publishDefinitionVersion();
      return;
    }
    if (payload?.type === "projectAiModel" && this.options.dataSource.setAiModel && !this.initializing) {
      await this.options.dataSource.setAiModel(typeof payload.model === "string" && payload.model ? payload.model : undefined);
      await this.publishDefinitionVersion();
      return;
    }
    if (payload?.type === "projectAiReasoning" && this.options.dataSource.setAiReasoning && !this.initializing) {
      await this.options.dataSource.setAiReasoning(typeof payload.reasoningEffort === "string" && payload.reasoningEffort ? payload.reasoningEffort : undefined);
      await this.publishDefinitionVersion();
      return;
    }
    if (payload?.type === "projectAiSpeed" && this.options.dataSource.setAiSpeed && !this.initializing) {
      await this.options.dataSource.setAiSpeed(typeof payload.speed === "string" && payload.speed ? payload.speed : undefined);
      await this.publishDefinitionVersion();
      return;
    }
    if (payload?.type === "projectDiagramRender" && typeof payload.diagramId === "string") {
      await this.options.dataSource.renderDiagram?.(payload.diagramId, typeof payload.version === "number" ? payload.version : undefined, payload.refresh === true ? { refresh: true } : {});
      return;
    }
    if (payload?.type === "projectDiagramGenerate" && typeof payload.requirement === "string") {
      await this.options.dataSource.generateDiagram?.({
        requirement: payload.requirement,
        ...(typeof payload.kind === "string" && payload.kind ? { kind: payload.kind } : {}),
        ...(typeof payload.diagramId === "string" && payload.diagramId ? { diagramId: payload.diagramId } : {})
      });
      return;
    }
    if (payload?.type === "projectDiagramExport" && typeof payload.diagramId === "string") {
      await this.options.dataSource.exportDiagram?.({
        diagramId: payload.diagramId,
        ...(typeof payload.version === "number" ? { version: payload.version } : {}),
        ...(typeof payload.format === "string" ? { format: payload.format } : {}),
        ...(typeof payload.content === "string" ? { content: payload.content } : {})
      });
      return;
    }
    if (payload?.type === "projectDiagramEvidence" && typeof payload.diagramId === "string" && typeof payload.nodeId === "string" && typeof payload.path === "string") {
      await this.options.dataSource.openDiagramEvidence?.(
        payload.diagramId,
        payload.nodeId,
        payload.path,
        typeof payload.line === "number" ? payload.line : undefined
      );
      return;
    }
    if (payload?.type === "projectEvidenceOpen" && typeof payload.path === "string") {
      await this.options.dataSource.openEvidencePath?.(payload.path);
      return;
    }
    if (payload?.type === "projectDiagramCancel") {
      this.options.dataSource.cancelDiagramWork?.();
      return;
    }
    const page = payload?.type === "projectPage" ? payload.page : payload?.page;
    if (typeof page === "string" && (page === "overview" || page === "knowledge" || page === "architecture")) {
      if (this.page !== page) this.options.dataSource.cancelDiagramWork?.();
      this.pages.set(this.key, page);
      this.focusObjectId = undefined;
      const data = await this.options.dataSource.load();
      const opened = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
      this.activePanel = opened.panel;
      this.lastData = data;
      opened.panel.setHtml?.(this.render(page, data));
    }
  }
}
