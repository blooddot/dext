import { editorTabKey } from "./editorTabTypes.js";
import { createEditorTabState } from "./editorTabState.js";
import { describeEditorTab, type EditorTabManager } from "./editorTabManager.js";
import type { EditorTabRestorer } from "./editorTabSerializer.js";
import { renderProjectPanel, type ProjectPanelData, type ProjectPanelPage } from "./webview/projectPanel.js";
import type { ProjectInitializationState } from "./projectService.js";
export interface ProjectEditorDataSource {
  load(): Promise<ProjectPanelData>;
  /** Drop cached source data after the user changes scan folders. */
  invalidateScan?(): void | Promise<void>;
  initialize?(): Promise<ProjectPanelData>;
  initialization?(): ProjectInitializationState;
  onInitializationChange?(listener: (state: ProjectInitializationState) => void): () => void;
  setAiCli?(cli?: string): Promise<void> | void;
  setAiModel?(model?: string): Promise<void> | void;
  setAiReasoning?(reasoningEffort?: string): Promise<void> | void;
  setAiSpeed?(speed?: string): Promise<void> | void;
  setDiagramAdapter?(kind: string, adapterId?: string): Promise<void> | void;
  regenerateDiagram?(kind: string): Promise<void> | void;
  exportDiagram?(kind: string, format?: string): Promise<void> | void;
  showDiagramValidation?(kind: string): Promise<void> | void;
  focusDiagramNode?(kind: string, objectId: string): Promise<void> | void;
}

export interface ProjectEditorProviderOptions {
  manager: EditorTabManager;
  restorer: EditorTabRestorer;
  dataSource: ProjectEditorDataSource;
  /** Main workspace root. The first version keeps a single root. */
  scope?: string;
  chooseScanRoots?: () => Promise<void>;
}

export interface ProjectEditorShowResult {
  key: string;
  created: boolean;
  page: ProjectPanelPage;
}

/**
 * Project editor tab. It exposes only Overview, Knowledge, and Architecture; there is deliberately
 * no Hooks, Review, or task-execution page and no run metadata in the data it loads.
 */
export class ProjectEditorProvider {
  private readonly pages = new Map<string, ProjectPanelPage>();
  private focusObjectId: string | undefined;
  private initializing = false;
  private activePanel: ReturnType<EditorTabManager["open"]>["panel"] | undefined;
  private lastData: ProjectPanelData | undefined;
  readonly key: string;

  constructor(private readonly options: ProjectEditorProviderOptions) {
    this.key = editorTabKey("project", options.scope ? { scope: options.scope } : {});
    options.dataSource.onInitializationChange?.((state) => this.activePanel?.postMessage?.({ type: "projectInitializationProgress", state }));
  }

  get page(): ProjectPanelPage {
    return this.pages.get(this.key) ?? "overview";
  }

  private render(page: ProjectPanelPage, data: ProjectPanelData): string {
    return renderProjectPanel(page, data, this.focusObjectId ? { focusObjectId: this.focusObjectId } : {});
  }

  /** Opens a page. A focus id marks the long-term object an adopted suggestion wrote. */
  async show(page: ProjectPanelPage = "overview", focusObjectId?: string): Promise<ProjectEditorShowResult> {
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

  /** Handles webview messages routed by the shared manager. */
  async handleMessage(key: string, message: unknown): Promise<void> {
    if (key !== this.key) return;
    const payload = message as { type?: unknown; page?: unknown; kind?: unknown; adapterId?: unknown; action?: unknown; format?: unknown; objectId?: unknown; cli?: unknown; model?: unknown; reasoningEffort?: unknown; speed?: unknown };
    if (payload?.type === "projectInitialize" && this.options.dataSource.initialize && !this.initializing) {
      this.initializing = true;
      // Start the task before awaiting it so a tab switch can immediately reload the
      // running snapshot. The running render is intentionally independent of the
      // completion render below; otherwise replacing the webview while initialization
      // is in flight makes the progress indicator disappear.
      const task = this.options.dataSource.initialize();
      // Keep a rejection handler attached even if the optimistic running render
      // fails before we reach the normal await below.
      void task.catch(() => undefined);
      try {
        // Progress events are pushed to the existing webview immediately. Waiting for `load()`
        // here would wait for the complete source scan and hide the real scan progress.
        if (this.lastData) {
          const state = this.options.dataSource.initialization?.() ?? { ...this.lastData.overview.initialization, status: "running" as const, phase: "scanning" as const };
          const runningData = { ...this.lastData, overview: { ...this.lastData.overview, initialization: state } };
          this.activePanel?.setHtml?.(this.render(this.page, runningData));
        }
        const data = await task;
        // Keep whichever page the user selected while the initialization task was
        // running. Replacing it with Overview made a tab switch feel lost.
        const completedPanel = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
        this.activePanel = completedPanel.panel;
        this.lastData = data;
        completedPanel.panel.setHtml?.(this.render(this.page, data));
      } catch {
        // A failed run is represented by the persisted initialization snapshot. Keep
        // the panel usable and let the next click retry instead of leaving a rejected
        // webview message promise behind.
        try {
          const data = await this.options.dataSource.load();
          const opened = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
          this.activePanel = opened.panel;
          this.lastData = data;
          opened.panel.setHtml?.(this.render(this.page, data));
        } catch {
          // Loading a failure snapshot is best effort; the original initialization
          // error has already been reflected by the service state.
        }
      } finally {
        this.initializing = false;
      }
      return;
    }
    if (payload?.type === "projectChooseRoots" && this.options.chooseScanRoots && !this.initializing) {
      await this.options.chooseScanRoots();
      await this.options.dataSource.invalidateScan?.();
      const data = await this.options.dataSource.load();
      const opened = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
      this.activePanel = opened.panel;
      this.lastData = data;
      opened.panel.setHtml?.(this.render("overview", data));
      return;
    }
    if (payload?.type === "projectAiCli" && this.options.dataSource.setAiCli && !this.initializing) {
      await this.options.dataSource.setAiCli(typeof payload.cli === "string" && payload.cli ? payload.cli : undefined);
      return;
    }
    if (payload?.type === "projectAiModel" && this.options.dataSource.setAiModel && !this.initializing) {
      await this.options.dataSource.setAiModel(typeof payload.model === "string" && payload.model ? payload.model : undefined);
      return;
    }
    if (payload?.type === "projectAiReasoning" && this.options.dataSource.setAiReasoning && !this.initializing) {
      await this.options.dataSource.setAiReasoning(typeof payload.reasoningEffort === "string" && payload.reasoningEffort ? payload.reasoningEffort : undefined);
      return;
    }
    if (payload?.type === "projectAiSpeed" && this.options.dataSource.setAiSpeed && !this.initializing) {
      await this.options.dataSource.setAiSpeed(typeof payload.speed === "string" && payload.speed ? payload.speed : undefined);
      return;
    }
    if (payload?.type === "projectAdapterPreference" && typeof payload.kind === "string" && this.options.dataSource.setDiagramAdapter) {
      await this.options.dataSource.setDiagramAdapter(payload.kind, typeof payload.adapterId === "string" ? payload.adapterId : undefined);
      // Keep the existing webview alive while the native select is open. A
      // full setHtml rerender closes the popup and makes the choice flash away.
      return;
    }
    if (payload?.type === "projectDiagramAction" && typeof payload.kind === "string") {
      const action = payload.action;
      if (action === "regenerate") await this.options.dataSource.regenerateDiagram?.(payload.kind);
      else if (action === "receipt") await this.options.dataSource.showDiagramValidation?.(payload.kind);
      else if (action === "export") await this.options.dataSource.exportDiagram?.(payload.kind, typeof payload.format === "string" ? payload.format : undefined);
      else if (action === "auto") await this.options.dataSource.setDiagramAdapter?.(payload.kind, undefined);
      if (action !== "auto") {
        const data = await this.options.dataSource.load();
        const opened = this.options.manager.open(describeEditorTab("project", this.key, "dext.project"));
        this.activePanel = opened.panel;
        this.lastData = data;
        opened.panel.setHtml?.(this.render(this.page, data));
      }
      return;
    }
    if (payload?.type === "projectDiagramFocus" && typeof payload.kind === "string" && typeof payload.objectId === "string") {
      await this.options.dataSource.focusDiagramNode?.(payload.kind, payload.objectId);
      return;
    }
    const page = payload?.type === "projectPage" ? payload.page : payload?.page;
    if (typeof page === "string" && (page === "overview" || page === "knowledge" || page === "architecture")) {
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
