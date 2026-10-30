import { describeEditorTab, type EditorTabManager } from "../../../platform/editor-tabs/editorTabManager.js";
import type { EditorTabRestorer } from "../../../platform/editor-tabs/editorTabSerializer.js";
import { createEditorTabState } from "../../../platform/editor-tabs/editorTabState.js";
import { editorTabKey } from "../../../platform/editor-tabs/editorTabTypes.js";
import type { ProjectInitializationState, ProjectInitializationStatus } from "../contracts/lifecycle.js";
import type { ProjectEditorDataSource } from "../contracts/reader.js";
import { renderProjectPanel, type ProjectPanelData, type ProjectPanelPage } from "../presentation/projectPanel.js";
export type { ProjectEditorDataSource, ProjectReaderEvidenceRequest, ProjectReaderExportRequest, ProjectReaderRenderRequest } from "../contracts/reader.js";

export interface ProjectEditorProviderOptions {
  manager: EditorTabManager;
  restorer: EditorTabRestorer;
  dataSource: ProjectEditorDataSource;
  /** Main workspace root. The first version keeps a single root. */
  scope?: string;
  copyText?(text: string): PromiseLike<void> | void;
  planFromProjectObject?(id: string): PromiseLike<void> | void;
  /** Opens the Resources editor on a saved norm, so Knowledge need not route through the picker. */
  editProjectNorm?(id: string): PromiseLike<void> | void;
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
  /** Identifies the newest run, so a paused predecessor settling late cannot repaint over it. */
  private initializationRun = 0;
  /** Status currently rendered on the Overview card; percentage updates are handled in the page. */
  private renderedInitializationStatus: ProjectInitializationStatus | undefined;
  private activePanel: ReturnType<EditorTabManager["open"]>["panel"] | undefined;
  private lastData: ProjectPanelData | undefined;
  private selectedDiagramId: string | undefined;
  private readonly unsubscribeMessages: (() => void) | undefined;
  private readonly unsubscribeInitialization: (() => void) | undefined;
  readonly key: string;

  constructor(private readonly options: ProjectEditorProviderOptions) {
    this.key = editorTabKey("project", options.scope ? { scope: options.scope } : {});
    this.unsubscribeInitialization = options.dataSource.onInitializationChange?.((state) => {
      this.post({ type: "projectInitializationProgress", state });
      this.applyInitializationState(state);
    });
    this.unsubscribeMessages = options.dataSource.subscribe?.((message) => this.post(message));
  }

  get page(): ProjectPanelPage {
    return this.pages.get(this.key) ?? "overview";
  }

  private render(page: ProjectPanelPage, data: ProjectPanelData): string {
    const selected = data.architecture.diagrams.find((diagram) => diagram.id === this.selectedDiagramId);
    if (selected) data = { ...data, architecture: { ...data.architecture, selected } };
    // The page script persists this exact state so a reload restores the same page.
    const state = createEditorTabState(this.key, { page });
    return renderProjectPanel(page, data, {
      ...(this.focusObjectId ? { focusObjectId: this.focusObjectId } : {}),
      ...(state ? { state } : {})
    });
  }

  /**
   * Sends a message to the active tab and forgets a panel that has already closed.
   *
   * VS Code raises `Webview is disposed` from `postMessage`/`html` when a tab closes while a long
   * initialization is still reporting progress. A progress update is not part of the run's result:
   * letting it throw would abort the AI generation that produced it, so a closed view is treated as
   * "nowhere to render" instead.
   */
  private post(message: unknown): void {
    const panel = this.activePanel;
    if (!panel) return;
    try {
      panel.postMessage?.(message);
    } catch {
      if (this.activePanel === panel) this.activePanel = undefined;
    }
  }

  /** Renders into the active tab with the same disposal tolerance as {@link post}. */
  private setHtml(html: string): void {
    const panel = this.activePanel;
    if (!panel) return;
    try {
      panel.setHtml?.(html);
    } catch {
      if (this.activePanel === panel) this.activePanel = undefined;
    }
  }

  /**
   * Repaints the Overview card when the run changes status.
   *
   * Percentage updates are cheap and the page script applies them in place, but a transition —
   * running to paused, failed or completed — changes which controls and copy belong on the card.
   * Without a repaint, Pause would leave a disabled "Pausing…" button (and no Resume) until the
   * whole page was reopened, and a resumed run would keep an empty checkpoint card on screen.
   */
  private applyInitializationState(state: ProjectInitializationState): void {
    if (!this.lastData) return;
    this.lastData = { ...this.lastData, overview: { ...this.lastData.overview, initialization: state } };
    if (state.status === this.renderedInitializationStatus) return;
    this.renderedInitializationStatus = state.status;
    // The card lives on Overview; another page is rendered from fresh data when it is opened.
    if (this.page !== "overview") return;
    this.setHtml(this.render(this.page, this.lastData));
  }

  /** Starts the visible card before the data source reaches its first await. */
  private renderStartingInitialization(resuming: boolean, percent = 0): void {
    if (!this.lastData) return;
    const state: ProjectInitializationState = {
      status: "running",
      startedAt: Date.now(),
      phase: "preparing",
      // A resumed run keeps its saved percentage so re-indexing does not look like a fresh start.
      percent: resuming ? Math.max(0, Math.min(99, Math.round(percent))) : 0,
      message: resuming ? "Re-indexing current sources before resuming…" : "Preparing the local structure index…"
    };
    this.renderedInitializationStatus = "running";
    this.lastData = { ...this.lastData, overview: { ...this.lastData.overview, initialization: state } };
    this.setHtml(this.render(this.page, this.lastData));
  }

  private rememberRenderedState(data: ProjectPanelData): void {
    this.lastData = data;
    this.renderedInitializationStatus = data.overview.initialization.status;
  }

  /** Opens a page. A focus id marks the long-term object an adopted suggestion wrote. */
  async show(page: ProjectPanelPage = "overview", focusObjectId?: string): Promise<ProjectEditorShowResult> {
    const previous = this.pages.get(this.key);
    if (previous && previous !== page) this.options.dataSource.cancelDiagramWork?.();
    this.pages.set(this.key, page);
    this.focusObjectId = focusObjectId;
    const data = await this.options.dataSource.load();
    this.rememberRenderedState(data);
    const descriptor = describeEditorTab("project", this.key, "dext.project");
    const result = this.options.manager.open(descriptor);
    this.activePanel = result.panel;
    this.setHtml(this.render(page, data));
    return { key: this.key, created: result.created, page };
  }

  /** Restores the last page selection through the shared restorer, avoiding a duplicate panel. */
  async restore(state: unknown): Promise<"opened" | "reused" | "skipped" | "invalid"> {
    const restored = createEditorTabState(this.key, { page: this.page });
    const outcome = this.options.restorer.restore(state ?? restored, "serializer");
    if (outcome.status === "opened" && outcome.key) {
      const data = await this.options.dataSource.load();
      this.rememberRenderedState(data);
      const opened = this.options.manager.open(describeEditorTab("project", outcome.key, "dext.project"));
      this.activePanel = opened.panel;
      this.setHtml(this.render(this.page, data));
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
    if (data.overview.evidenceSettingsVersion !== undefined) this.post({ type: "projectDefinitionVersion", version: data.overview.evidenceSettingsVersion });
  }

  /** Handles webview messages routed by the shared manager. */
  async handleMessage(key: string, message: unknown): Promise<void> {
    if (key !== this.key) return;
    const payload = message as {
      type?: unknown; page?: unknown; diagramId?: unknown; version?: unknown; kind?: unknown;
      requirement?: unknown; format?: unknown; content?: unknown; nodeId?: unknown; path?: unknown; line?: unknown; refresh?: unknown;
      cli?: unknown; model?: unknown; reasoningEffort?: unknown; speed?: unknown;
      settings?: unknown;
      topicId?: unknown; evidenceIndex?: unknown;
      updatedAt?: unknown; elementId?: unknown; elementKind?: unknown;
      requestId?: unknown;
      text?: unknown;
      objectId?: unknown;
    };
    if (payload?.type === "projectEditNorm" && typeof payload.objectId === "string") {
      if (!this.options.editProjectNorm) throw new Error("Editing Project norms is unavailable.");
      await this.options.editProjectNorm(payload.objectId);
      return;
    }
    if (payload?.type === "projectPlan" && typeof payload.topicId === "string") {
      if (!this.options.planFromProjectObject) throw new Error("Project Plan action is unavailable.");
      await this.options.planFromProjectObject(payload.topicId);
      return;
    }
    if (payload?.type === "projectQualityCopy" && typeof payload.text === "string" && typeof payload.requestId === "number" && Number.isSafeInteger(payload.requestId)) {
      try {
        if (!this.options.copyText) throw new Error("Clipboard is unavailable.");
        await this.options.copyText(payload.text);
        this.post({ type: "projectQualityCopied", requestId: payload.requestId, success: true });
      } catch {
        this.post({ type: "projectQualityCopied", requestId: payload.requestId, success: false });
      }
      return;
    }
    if (payload?.type === "projectKnowledgeCheck") {
      await this.options.dataSource.checkKnowledge?.();
      return;
    }
    if (payload?.type === "projectReaderRender" && typeof payload.diagramId === "string" && typeof payload.updatedAt === "number" && typeof payload.requestId === "string") {
      await this.options.dataSource.renderReaderDiagram?.({ diagramId: payload.diagramId, updatedAt: payload.updatedAt, requestId: payload.requestId });
      return;
    }
    if (payload?.type === "projectReaderEvidence" && typeof payload.diagramId === "string" && typeof payload.updatedAt === "number"
      && typeof payload.elementId === "string" && (payload.elementKind === "node" || payload.elementKind === "relation") && typeof payload.evidenceIndex === "number") {
      await this.options.dataSource.openReaderEvidence?.({ diagramId: payload.diagramId, updatedAt: payload.updatedAt, elementId: payload.elementId, elementKind: payload.elementKind, evidenceIndex: payload.evidenceIndex });
      return;
    }
    if (payload?.type === "projectReaderExport" && typeof payload.diagramId === "string" && typeof payload.updatedAt === "number" && typeof payload.content === "string") {
      await this.options.dataSource.exportReaderDiagram?.({ diagramId: payload.diagramId, updatedAt: payload.updatedAt, content: payload.content });
      return;
    }
    if (payload?.type === "projectTopicEvidence" && typeof payload.topicId === "string" && typeof payload.evidenceIndex === "number") {
      await this.options.dataSource.openTopicEvidence?.(payload.topicId, payload.evidenceIndex);
      return;
    }
    if (payload?.type === "projectTopicOpenDiagram" && typeof payload.diagramId === "string") {
      this.selectedDiagramId = payload.diagramId;
      await this.show("architecture");
      return;
    }
    if (payload?.type === "projectTopicDiagram" && typeof payload.topicId === "string") {
      await this.options.dataSource.generateTopicDiagram?.(payload.topicId);
      return;
    }
    if (payload?.type === "projectSettings" && this.options.dataSource.setProjectSettings) {
      try {
        if (this.initializing) throw new Error("Wait for initialization to finish before saving settings.");
        if (typeof payload.version !== "number" || !Number.isInteger(payload.version) || payload.version < 0) throw new Error("Reopen Overview before saving settings.");
        await this.options.dataSource.setProjectSettings(payload.settings, payload.version);
        const data = await this.options.dataSource.load();
        this.lastData = data;
        this.post({ type: "projectSettingsSaved", version: data.overview.workspaceSettingsVersion ?? data.overview.evidenceSettingsVersion });
      } catch (error) {
        this.post({ type: "projectSettingsSaved", error: error instanceof Error ? error.message : String(error) });
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
        this.post({ type: "projectWorkspaceSettingsSaved", version: data.overview.workspaceSettingsVersion });
      } catch (error) {
        this.post({ type: "projectWorkspaceSettingsSaved", error: error instanceof Error ? error.message : String(error) });
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
        this.post({ type: "projectEvidenceSettingsSaved", version: data.overview.evidenceSettingsVersion });
      } catch (error) {
        this.post({ type: "projectEvidenceSettingsSaved", error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    // A paused run is already aborted; letting the user resume before its promise settles is what
    // makes Pause -> Resume feel immediate instead of needing a page reload. The older handler is
    // fenced by `initializationRun`, so its late catch cannot repaint over the new run.
    const pausedState = this.options.dataSource.initialization?.();
    const resumingPausedRun = pausedState?.status === "cancelled";
    if (payload?.type === "projectInitialize" && this.options.dataSource.initialize && (!this.initializing || resumingPausedRun)) {
      const run = ++this.initializationRun;
      this.initializing = true;
      // Render the running card before the data source reaches its first await (it reads the
      // checkpoint first). Reading the stale snapshot here would render the paused card again and
      // make Resume look like it did nothing while progress streamed into a hidden block.
      this.renderStartingInitialization(Boolean(pausedState?.resumable), pausedState?.resumePercent ?? 0);
      // Start the task before awaiting it so a tab switch can immediately reload the running
      // snapshot. The running render is intentionally independent of the completion render.
      const task = this.options.dataSource.initialize();
      void task.catch(() => undefined);
      try {
        const data = await task;
        if (this.initializationRun !== run) return;
        const completedPanel = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
        this.activePanel = completedPanel.panel;
        this.rememberRenderedState(data);
        this.setHtml(this.render(this.page, data));
      } catch {
        if (this.initializationRun !== run) return;
        // A failed run is represented by the persisted initialization snapshot. Keep the panel
        // usable and let the next click retry instead of leaving a rejected message promise behind.
        try {
          const data = await this.options.dataSource.load();
          if (this.initializationRun !== run) return;
          const opened = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
          this.activePanel = opened.panel;
          this.rememberRenderedState(data);
          this.setHtml(this.render(this.page, data));
        } catch {
          // Loading a failure snapshot is best effort.
        }
      } finally {
        if (this.initializationRun === run) this.initializing = false;
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
    if (payload?.type === "projectDiagramCancel") {
      this.options.dataSource.cancelDiagramWork?.();
      return;
    }
    if (payload?.type === "projectInitializePause") {
      this.options.dataSource.pauseInitialization?.();
      return;
    }
    const page = payload?.type === "projectPage" ? payload.page : payload?.page;
    if (typeof page === "string" && (page === "overview" || page === "knowledge" || page === "architecture")) {
      if (this.page !== page) this.options.dataSource.cancelDiagramWork?.();
      this.pages.set(this.key, page);
      this.focusObjectId = typeof payload.topicId === "string" ? payload.topicId : undefined;
      const data = await this.options.dataSource.load();
      const opened = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
      this.activePanel = opened.panel;
      this.rememberRenderedState(data);
      this.setHtml(this.render(page, data));
    }
  }
}
