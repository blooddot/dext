import { editorTabKey } from "./editorTabTypes.js";
import { createEditorTabState } from "./editorTabState.js";
import { describeEditorTab, type EditorTabManager } from "./editorTabManager.js";
import type { EditorTabRestorer } from "./editorTabSerializer.js";
import { renderProjectPanel, type ProjectPanelData, type ProjectPanelPage } from "./webview/projectPanel.js";
export interface ProjectEditorDataSource {
  load(): Promise<ProjectPanelData>;
  initialize?(): Promise<ProjectPanelData>;
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
  readonly key: string;

  constructor(private readonly options: ProjectEditorProviderOptions) {
    this.key = editorTabKey("project", options.scope ? { scope: options.scope } : {});
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
    const descriptor = describeEditorTab("project", this.key, "dext.project");
    const result = this.options.manager.open(descriptor);
    result.panel.setHtml?.(this.render(page, data));
    return { key: this.key, created: result.created, page };
  }

  /** Restores the last page selection through the shared restorer, avoiding a duplicate panel. */
  async restore(state: unknown): Promise<"opened" | "reused" | "skipped" | "invalid"> {
    const restored = createEditorTabState(this.key, { page: this.page });
    const outcome = this.options.restorer.restore(state ?? restored, "serializer");
    if (outcome.status === "opened" && outcome.key) {
      const data = await this.options.dataSource.load();
      this.options.manager.open(describeEditorTab("project", outcome.key, "dext.project")).panel.setHtml?.(this.render(this.page, data));
    }
    return outcome.status;
  }

  /** Handles webview messages routed by the shared manager. */
  async handleMessage(key: string, message: unknown): Promise<void> {
    if (key !== this.key) return;
    const payload = message as { type?: unknown; page?: unknown };
    if (payload?.type === "projectInitialize" && this.options.dataSource.initialize && !this.initializing) {
      this.initializing = true;
      try {
        const data = await this.options.dataSource.initialize();
        this.options.manager.open(describeEditorTab("project", this.key, "dext.project")).panel.setHtml?.(this.render("overview", data));
      } finally {
        this.initializing = false;
      }
      return;
    }
    if (payload?.type === "projectChooseRoots" && this.options.chooseScanRoots && !this.initializing) {
      await this.options.chooseScanRoots();
      const data = await this.options.dataSource.load();
      this.options.manager.open(describeEditorTab("project", this.key, "dext.project")).panel.setHtml?.(this.render("overview", data));
      return;
    }
    const page = payload?.type === "projectPage" ? payload.page : payload?.page;
    if (typeof page === "string" && (page === "overview" || page === "knowledge" || page === "architecture")) {
      this.pages.set(this.key, page);
      this.focusObjectId = undefined;
      const data = await this.options.dataSource.load();
      this.options.manager.open(describeEditorTab("project", this.key, "dext.project")).panel.setHtml?.(this.render(page, data));
    }
  }
}
