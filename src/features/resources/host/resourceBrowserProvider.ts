import { describeEditorTab } from "../../../platform/editor-tabs/editorTabManager.js";
import { createEditorTabState } from "../../../platform/editor-tabs/editorTabState.js";
import { type ResourceEditorProviderOptions, type ResourceEditorShowResult, type ResourcePanelOptions } from "../contracts/resourceDocuments.js";
import type { ResourceKind, ResourcePage } from "../contracts/resourceSession.js";
import { renderApiDetail, renderApiList } from "../presentation/apiPanel.js";
import { renderGlobalResources } from "../presentation/globalResourcesPanel.js";
import { buildResourceDefinition, buildResourceList, renderResourceError } from "../presentation/resourceDocuments.js";
import { ResourceEditorProvider } from "./resourceEditorProvider.js";

/**
 * Browse the file resources and the built-in Dext APIs in one tab, switching between
 * Project, Global and Dext, and retaining each history entry's view state.
 */
export class ResourceBrowserProvider extends ResourceEditorProvider {
  private history: ResourceLocation[];
  private position = 0;
  private revision = 0;

  constructor(options: ResourceEditorProviderOptions) {
    super(options);
    this.history = [{ query: "", scrollTop: 0, scope: options.scope, collapsed: [] }];
  }

  get currentScope(): ResourcePage { return this.history[this.position]!.scope; }

  /** Every file resource kind this page lists; the Dext page reports its own catalogue. */
  protected override listKinds(): readonly ResourceKind[] {
    return ["api", "mcp", "rule", "skill"];
  }

  override showList(query = ""): Promise<ResourceEditorShowResult> {
    return this.navigate({ query, scrollTop: 0, scope: this.currentScope, collapsed: [] });
  }

  override showDetail(id: string): Promise<ResourceEditorShowResult> {
    return this.navigate({ id, query: "", scrollTop: 0, scope: this.currentScope, collapsed: [] });
  }

  override async handleMessage(key: string, message: unknown): Promise<void> {
    if (key !== this.listTabKey) return;
    const payload = (message ?? {}) as { type?: unknown; scope?: unknown; direction?: unknown; query?: unknown; command?: unknown; id?: unknown; kind?: unknown; pack?: unknown; path?: unknown; viewState?: { query?: unknown; scrollTop?: unknown; collapsed?: unknown } };
    const current = this.history[this.position]!;
    if (Array.isArray(payload.viewState?.collapsed)) current.collapsed = payload.viewState.collapsed.filter((value): value is string => typeof value === "string");
    if (typeof payload.viewState?.query === "string" && !current.id) current.query = payload.viewState.query;
    if (typeof payload.viewState?.scrollTop === "number" && Number.isFinite(payload.viewState.scrollTop)) {
      current.scrollTop = Math.max(0, payload.viewState.scrollTop);
    }
    if (payload.type === "resourceScope") {
      const scope = payload.scope;
      if ((scope === "global" || scope === "project" || scope === "builtin") && (this.options.availableScopes?.() ?? ["project", "global", "builtin"]).includes(scope)) {
        if (scope !== current.scope) await this.navigate({ scope, query: "", scrollTop: 0, collapsed: [] });
      }
      return;
    }
    if (payload.type === "resourceNavigate" && payload.direction === "namespace" && typeof payload.query === "string") {
      await this.showList(payload.query);
      return;
    }
    if (payload.type === "resourceNavigate") {
      if (payload.direction === "home") {
        let home = -1;
        for (let index = this.history.length - 1; index >= 0; index -= 1) {
          if (!this.history[index]!.id && this.history[index]!.scope === current.scope) { home = index; break; }
        }
        if (home >= 0) await this.navigate(this.history[home]!, home);
        else await this.showList();
      } else {
        const index = this.position + (payload.direction === "back" ? -1 : payload.direction === "forward" ? 1 : 0);
        if (index !== this.position && index >= 0 && index < this.history.length) await this.navigate(this.history[index]!, index);
      }
      return;
    }
    if (payload.type === "refresh" || (payload.type === "resourceCommand" && payload.command === `${this.options.commandPrefix ?? "dext"}.reloadMethods`)) {
      if (payload.type === "resourceCommand") await this.options.onCommand?.(payload.command as string, { scope: current.scope });
      await this.navigate(current, this.position);
      return;
    }
    if (payload.type === "resourceCommand" && typeof payload.command === "string") {
      const parameters = {
        scope: current.scope,
        ...(typeof payload.id === "string" ? { id: payload.id } : {}),
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
        ...(typeof payload.pack === "string" ? { pack: payload.pack } : {}),
        ...(typeof payload.path === "string" ? { path: payload.path } : {}),
        ...(typeof payload.query === "string" ? { query: payload.query } : {})
      };
      // These commands change what this list itself renders. A Skill's visibility
      // does too, but its checkbox already flipped in the page, so re-rendering
      // would only cost a file scan and a visible repaint.
      const reRendersList = /\.(?:deleteResource|upgradeSkillPack)$/.test(payload.command);
      try {
        const changed = await this.options.onCommand?.(payload.command, parameters);
        if (changed === true && reRendersList) {
          await this.navigate({ query: current.query, scrollTop: current.scrollTop, scope: current.scope, collapsed: current.collapsed });
        }
      } catch (error) {
        if (reRendersList) await this.navigate({ query: current.query, scrollTop: current.scrollTop, scope: current.scope, collapsed: current.collapsed });
        throw error;
      }
      return;
    }
    await super.handleMessage(key, message);
  }

  /** The built-in APIs have no file scope of their own, so they read their own data source. */
  private dataSource(page: ResourcePage) {
    return page === "builtin" ? this.options.builtinDataSource : this.options.dataSource;
  }

  private async navigate(location: ResourceLocation, targetPosition?: number): Promise<ResourceEditorShowResult> {
    const revision = ++this.revision;
    const builtin = location.scope === "builtin";
    const dataSource = this.dataSource(location.scope);
    let render: (options: ResourcePanelOptions) => string;
    let label: string | undefined;
    if (location.id) {
      const document = await dataSource?.definition(location.id);
      if (!document) {
        if (targetPosition === undefined) throw new Error(`Resource '${location.id}' is no longer available.`);
        label = location.id;
        render = (options) => renderResourceError(location.id!, "This API is no longer available. Go back or refresh to try again.", options);
      } else {
        if (!builtin) location.scope = document.entry.scope;
        label = document.entry.name;
        render = (options) => renderApiDetail(buildResourceDefinition(document.entry, document.content), options);
      }
    } else {
      // Keep all entries in the DOM so clearing a restored search reveals the full directory.
      const all = await dataSource?.list(this.listKinds(), "") ?? [];
      const entries = builtin ? all : all.filter((entry) => entry.scope === location.scope);
      const document = { ...buildResourceList({ kind: this.primaryKind(), scope: location.scope, entries, groupBy: builtin ? "directory" : "kind" }), query: location.query };
      render = builtin ? (options) => renderApiList(document, options) : (options) => renderGlobalResources(document, options);
    }
    if (revision !== this.revision) return { key: this.listTabKey, created: false };
    const current = this.history[this.position]!;
    if (targetPosition !== undefined) {
      this.position = targetPosition;
    } else if (current.id !== location.id || current.query !== location.query || current.scope !== location.scope) {
      this.history = [...this.history.slice(0, this.position + 1), location];
      this.position = this.history.length - 1;
    }
    const result = this.options.manager.open(describeEditorTab("globalResources", this.listTabKey, "dext.globalResources"));
    // Persisting the target means a reload restores this page instead of an empty tab.
    const tabState = createEditorTabState(this.listTabKey, {
      page: location.id ? "detail" : "list",
      ...(location.id ? { resourceId: location.id } : {})
    });
    result.panel.setHtml?.(render({
      ...(this.options.commandPrefix ? { commandPrefix: this.options.commandPrefix } : {}),
      // The built-in page is the API directory: it has no categories and no directory to open.
      ...(builtin ? {} : { title: "Resources", createKinds: this.listKinds(), openResourceDirectory: true }),
      scope: location.scope,
      availableScopes: this.options.availableScopes?.() ?? ["project", "global", "builtin"],
      ...(tabState ? { tabState } : {}),
      collapsed: this.history[this.position]!.collapsed,
      navigation: {
        canGoBack: this.position > 0,
        canGoForward: this.position < this.history.length - 1,
        ...(label ? { label } : {}),
        scrollTop: this.history[this.position]!.scrollTop
      }
    }));
    return { key: this.listTabKey, created: result.created };
  }
}

interface ResourceLocation {
  id?: string;
  query: string;
  scrollTop: number;
  scope: ResourcePage;
  collapsed: string[];
}
