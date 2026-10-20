import { describeEditorTab, type EditorTabManager } from "../../../platform/editor-tabs/editorTabManager.js";
import type { EditorTabRestorer } from "../../../platform/editor-tabs/editorTabSerializer.js";
import { createEditorTabState } from "../../../platform/editor-tabs/editorTabState.js";
import { editorTabKey } from "../../../platform/editor-tabs/editorTabTypes.js";
import type { ProjectEditorDataSource } from "../contracts/reader.js";
import { renderProjectPanel, type ProjectPanelData, type ProjectPanelPage } from "../presentation/projectPanel.js";
export type { ProjectEditorDataSource, ProjectReaderEvidenceRequest, ProjectReaderExportRequest, ProjectReaderRenderRequest } from "../contracts/reader.js";

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
  private selectedDiagramId: string | undefined;
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
    const selected = data.architecture.diagrams.find((diagram) => diagram.id === this.selectedDiagramId);
    if (selected) data = { ...data, architecture: { ...data.architecture, selected } };
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
      topicId?: unknown; evidenceIndex?: unknown;
      updatedAt?: unknown; elementId?: unknown; elementKind?: unknown;
      requestId?: unknown;
    };
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
    if (payload?.type === "projectDiagramCancel") {
      this.options.dataSource.cancelDiagramWork?.();
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
      this.lastData = data;
      opened.panel.setHtml?.(this.render(page, data));
    }
  }
}
