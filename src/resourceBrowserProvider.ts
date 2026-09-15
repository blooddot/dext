import { ResourceEditorProvider, buildResourceDefinition, buildResourceList, renderResourceError, type ResourceEditorProviderOptions, type ResourceEditorShowResult, type ResourcePanelOptions } from "./resourceDocuments.js";
import { describeEditorTab } from "./editorTabManager.js";
import { renderApiDetail, renderApiList } from "./webview/apiPanel.js";
import type { ResourceScope } from "./resourceSession.js";

/**
 * Browse the API directory and definitions in one tab, retaining each history entry's view state.
 */
export class ResourceBrowserProvider extends ResourceEditorProvider {
  private history: ResourceLocation[];
  private position = 0;
  private revision = 0;

  constructor(options: ResourceEditorProviderOptions, kind: "api" | "globalResources") {
    super({ renderList: renderApiList, renderDetail: renderApiDetail, ...options }, kind);
    this.history = [{ query: "", scrollTop: 0, scope: options.scope, collapsed: [] }];
  }

  get currentScope(): ResourceScope { return this.history[this.position]!.scope; }

  override detailKey(): string {
    return this.listTabKey;
  }

  override showList(query = ""): Promise<ResourceEditorShowResult> {
    return this.navigate({ query, scrollTop: 0, scope: this.currentScope, collapsed: [] });
  }

  override showDetail(id: string): Promise<ResourceEditorShowResult> {
    return this.navigate({ id, query: "", scrollTop: 0, scope: this.currentScope, collapsed: [] });
  }

  override async handleMessage(key: string, message: unknown): Promise<void> {
    if (key !== this.listTabKey) return;
    const payload = (message ?? {}) as { type?: unknown; scope?: unknown; direction?: unknown; query?: unknown; command?: unknown; viewState?: { query?: unknown; scrollTop?: unknown; collapsed?: unknown } };
    const current = this.history[this.position]!;
    if (Array.isArray(payload.viewState?.collapsed)) current.collapsed = payload.viewState.collapsed.filter((value): value is string => typeof value === "string");
    if (typeof payload.viewState?.query === "string" && !current.id) current.query = payload.viewState.query;
    if (typeof payload.viewState?.scrollTop === "number" && Number.isFinite(payload.viewState.scrollTop)) {
      current.scrollTop = Math.max(0, payload.viewState.scrollTop);
    }
    if (payload.type === "resourceScope" && this.tabKind === "globalResources") {
      const scope = payload.scope;
      if ((scope === "global" || scope === "project") && (this.options.availableScopes?.() ?? ["global", "project"]).includes(scope)) {
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
      await this.options.onCommand?.(payload.command, { scope: current.scope });
      return;
    }
    await super.handleMessage(key, message);
  }

  private async navigate(location: ResourceLocation, targetPosition?: number): Promise<ResourceEditorShowResult> {
    const revision = ++this.revision;
    let render: (options: ResourcePanelOptions) => string;
    let label: string | undefined;
    if (location.id) {
      const document = await this.options.dataSource.definition(location.id);
      if (!document) {
        if (targetPosition === undefined) throw new Error(`Resource '${location.id}' is no longer available.`);
        label = location.id;
        render = (options) => renderResourceError(location.id!, "This API is no longer available. Go back or refresh to try again.", options);
      } else {
        if (this.tabKind === "globalResources") location.scope = document.entry.scope;
        label = document.entry.name;
        render = (options) => (this.options.renderDetail ?? renderApiDetail)(buildResourceDefinition(document.entry, document.content), options);
      }
    } else {
      // Keep all entries in the DOM so clearing a restored search reveals the full directory.
      const all = await this.options.dataSource.list(this.listKinds(), "");
      const entries = this.tabKind === "globalResources" ? all.filter((entry) => entry.scope === location.scope && entry.source.kind !== "directory") : all;
      const document = { ...buildResourceList({ kind: this.primaryKind(), scope: location.scope, entries, groupBy: this.groupBy() }), query: location.query };
      render = (options) => (this.options.renderList ?? renderApiList)(document, options);
    }
    if (revision !== this.revision) return { key: this.listTabKey, created: false };
    const current = this.history[this.position]!;
    if (targetPosition !== undefined) {
      this.position = targetPosition;
    } else if (current.id !== location.id || current.query !== location.query || current.scope !== location.scope) {
      this.history = [...this.history.slice(0, this.position + 1), location];
      this.position = this.history.length - 1;
    }
    const result = this.options.manager.open(describeEditorTab(this.tabKind, this.listTabKey, this.viewType()));
    result.panel.setHtml?.(render({
      ...(this.options.commandPrefix ? { commandPrefix: this.options.commandPrefix } : {}),
      ...(this.tabKind === "globalResources" ? { title: "Resources", createKinds: this.listKinds(), scope: location.scope, availableScopes: this.options.availableScopes?.() ?? ["global", "project"] } : {}),
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
  scope: ResourceScope;
  collapsed: string[];
}
