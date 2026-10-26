import type { ApiReferenceCatalog, ApiReferenceModule } from "../../workflow/contracts/apiReference.js";
import { CONVERSATION_METHODS, formatFieldType, formatMethodParameter, methodResultType } from "../../workflow/domain/methodSignature.js";
import { describeEditorTab } from "../../../platform/editor-tabs/editorTabManager.js";
import { editorTabKey } from "../../../platform/editor-tabs/editorTabTypes.js";
import type { ApiCallable, ApiDataSourceOptions, FileResourceDataSourceOptions, ResourceEditorDataSource, ResourceEditorProviderOptions, ResourceEditorShowResult, ResourceEntry, ResourcePanelOptions } from "../contracts/resourceDocuments.js";
import { RESOURCE_DIRECTORIES, resourceDirectorySegments, type ResourceKind, type ResourceScope } from "../contracts/resourceSession.js";
import { buildResourceDefinition, buildResourceList, filterResourceEntries, renderResourceDefinition, renderResourceList, resourceEntryId } from "../presentation/resourceDocuments.js";


/**
 * Editor-tab behavior shared by the API directory and Global Resources. Opening the same target
 * reuses its page, and search, grouping, source jumps and reference insertion are preserved.
 */
export class ResourceEditorProvider {
  protected readonly listKey: string;
  protected readonly tabKind: "api" | "globalResources";

  constructor(protected readonly options: ResourceEditorProviderOptions, tabKind: "api" | "globalResources") {
    this.tabKind = tabKind;
    this.listKey = editorTabKey(tabKind, options.scopeKey ? { scope: options.scopeKey } : {});
  }

  detailKey(id: string): string {
    return editorTabKey(this.tabKind, {
      resourceId: id,
      ...(this.options.scopeKey ? { scope: this.options.scopeKey } : {})
    });
  }

  get listTabKey(): string {
    return this.listKey;
  }

  async showList(query = ""): Promise<ResourceEditorShowResult> {
    const kinds = this.listKinds();
    const entries = await this.options.dataSource.list(kinds, query);
    const document = buildResourceList({
      kind: this.primaryKind(),
      scope: this.options.scope,
      entries,
      query,
      groupBy: this.groupBy()
    });
    const result = this.options.manager.open(describeEditorTab(this.tabKind, this.listKey, this.viewType()));
    const render = this.options.renderList ?? renderResourceList;
    result.panel.setHtml?.(render(document, this.panelOptions()));
    return { key: this.listKey, created: result.created };
  }

  async showDetail(id: string): Promise<ResourceEditorShowResult> {
    const document = await this.options.dataSource.definition(id);
    if (!document) throw new Error(`Resource '${id}' is no longer available.`);
    const key = this.detailKey(id);
    const result = this.options.manager.open(describeEditorTab(this.tabKind, key, this.viewType(), document.entry.name));
    const render = this.options.renderDetail ?? renderResourceDefinition;
    result.panel.setHtml?.(render(buildResourceDefinition(document.entry, document.content), this.panelOptions()));
    return { key, created: result.created };
  }

  /** Handles list search, open, refresh and toolbar commands routed by the shared manager. */
  async handleMessage(key: string, message: unknown): Promise<void> {
    if (key !== this.listKey && this.options.manager.get(key)?.kind !== this.tabKind) return;
    const payload = (message ?? {}) as { type?: unknown; id?: unknown; kind?: unknown; path?: unknown; query?: unknown; text?: unknown };
    if (payload.type === "resourceCopy" && typeof payload.text === "string") {
      await this.options.copyText?.(payload.text);
      return;
    }
    if (payload.type === "resourceSearch" && typeof payload.query === "string" && key === this.listKey) {
      await this.showList(payload.query);
      return;
    }
    if (payload.type === "refresh" && key === this.listKey) {
      await this.showList();
      return;
    }
    if (payload.type === "resourceOpen" && typeof payload.id === "string") {
      await this.showDetail(payload.id);
      return;
    }
    if (payload.type === "resourceCommand") {
      const command = (payload as { command?: unknown }).command;
      if (typeof command !== "string") return;
      const changed = await this.options.onCommand?.(command, {
        ...(typeof payload.id === "string" ? { id: payload.id } : {}),
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
        ...(typeof payload.path === "string" ? { path: payload.path } : {}),
        ...(typeof payload.query === "string" ? { query: payload.query } : {})
      });
      if (command === `${this.options.commandPrefix ?? "dext"}.reloadMethods` || (changed === true && command.endsWith(".deleteResource"))) {
        await this.showList();
      }
    }
  }

  protected primaryKind(): ResourceKind {
    return "api";
  }

  /** Kinds shown by the list page. The Global Resources page reports its own categories instead. */
  protected listKinds(): readonly ResourceKind[] {
    return [this.primaryKind()];
  }

  protected groupBy(): "directory" | "kind" {
    return "directory";
  }

  private panelOptions(): ResourcePanelOptions {
    return {
      ...(this.options.commandPrefix !== undefined ? { commandPrefix: this.options.commandPrefix } : {}),
      ...(this.tabKind === "globalResources" ? { createKinds: this.listKinds() } : {})
    };
  }

  protected viewType(): string {
    return this.tabKind === "api" ? "dext.api" : "dext.globalResources";
  }
}


export function apiEntry(method: ApiCallable): ResourceEntry {
  const scope: ResourceScope = method.source === "project" ? "project" : "global";
  const path = `${method.id.replaceAll(".", "/")}.ts`;
  const input = method.input ?? [];
  const fields = input.filter((field) => !field.internal || CONVERSATION_METHODS.has(method.id));
  const returnType = method.output ? methodResultType(method) : "Result";
  return {
    id: resourceEntryId({ kind: "api", scope, path }),
    kind: "api",
    scope,
    name: method.id,
    path,
    group: method.id.includes(".") ? method.id.slice(0, method.id.lastIndexOf(".")) : ".",
    ...(method.title || method.description ? { description: method.title || method.description } : {}),
    api: {
      signature: `${method.id}(${fields.map(formatMethodParameter).join(", ")}) -> ${returnType}`,
      parameters: fields.map((field) => ({
        name: field.name,
        type: formatFieldType(field),
        required: field.required ?? true,
        ...(field.default !== undefined ? { defaultValue: JSON.stringify(field.default) } : {}),
        ...(field.description ? { description: field.description } : {})
      })),
      returnType
    },
    // Callable contracts describe runtime capabilities, not resource source files.
    source: { kind: "directory", label: method.source }
  };
}


/** A one-line summary for a reference module's list row: the declaration's own
 * first paragraph, or how much API the module carries. */
export function referenceSummary(module: ApiReferenceModule): string {
  const text = module.documentation?.split("\n\n")[0]?.replace(/\s+/g, " ").trim();
  if (text) return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
  return `${module.members.length} ${module.members.length === 1 ? "member" : "members"} from the TypeScript declaration`;
}


/** A Node module or JavaScript global as a read-only entry. It is an API page row
 * with no callable contract, so it carries the declaration's own documentation. */
export function apiReferenceEntry(module: ApiReferenceModule): ResourceEntry {
  const path = `${module.id}.json`;
  return {
    id: resourceEntryId({ kind: "api", scope: "global", path }),
    kind: "api",
    scope: "global",
    name: module.id,
    displayName: module.name,
    path,
    group: module.family,
    description: referenceSummary(module),
    reference: module,
    // A reference entry ships inside the extension's own declarations rather than
    // in a resource directory, so it is listed but not editable or openable.
    source: { kind: "directory", label: module.id.startsWith("node:") ? "module" : "global" }
  };
}


/** The Node and JavaScript reference the APIs page lists beside the callable APIs:
 * one entry per Node built-in module and per language global. */
export function apiReferenceEntries(catalog: ApiReferenceCatalog | undefined): ResourceEntry[] {
  return (catalog?.modules ?? []).map(apiReferenceEntry);
}


/** Resources are discovered from disk on each list/detail request, independently of callables. */
export function createFileResourceDataSource(options: FileResourceDataSourceOptions): ResourceEditorDataSource {
  const entries = async (kinds: readonly ResourceKind[]): Promise<ResourceEntry[]> => {
    const roots = options.roots();
    const files = await Promise.all((["api", "mcp", "rule", "skill"] as const).filter(kind => kinds.includes(kind)).map(async (kind) =>
      (await options.listFiles(kind)).flatMap((file): ResourceEntry[] => {
        const directory = roots[file.scope];
        if (!directory || (kind === "api" && file.path.endsWith(".d.ts"))) return [];
        return [{
          ...file, kind, id: resourceEntryId({ kind, ...file }),
          group: kind === "api"
            ? file.name.split(".").slice(0, -1).join(".") || "."
            : resourceDirectorySegments(kind, file.path).join("/") || ".",
          source: { kind: file.scope, label: file.scope === "project" ? "Project" : "Global", path: `${directory}/${RESOURCE_DIRECTORIES[kind]}/${file.path}` }
        }];
      })
    ));
    return files.flat();
  };
  // The function call graph is only needed by a detail page: a list would pay for
  // an extra parse of every API module just to show rows.
  const documentApi = async (entry: ResourceEntry, content: string, includeFlow = false): Promise<ResourceEntry> => {
    if (entry.kind !== "api") return entry;
    const functions = options.describeApi ? await options.describeApi(content) : [];
    const apiFlow = includeFlow && options.describeApiFlow ? await options.describeApiFlow(content) : undefined;
    if (!functions.length) return apiFlow ? { ...entry, apiFlow } : entry;
    const leaf = entry.name.split(".").at(-1);
    const apiFunctions = functions.map(item => ({ ...item,
      name: [leaf, "default", "main"].includes(item.name) ? entry.name : `${entry.name}.${item.name}`
    }));
    const primary = apiFunctions.find(item => item.name === entry.name) ?? apiFunctions[0]!;
    return { ...entry, api: primary.api, apiFunctions, ...(primary.description ? { description: primary.description } : {}), ...(apiFlow ? { apiFlow } : {}) };
  };
  return {
    list: async (kinds, query) => {
      const result: ResourceEntry[] = [];
      for (const entry of await entries(kinds)) {
        // Only API lists need source metadata. Read sequentially to bound memory and I/O.
        const content = entry.kind === "api" && options.describeApi ? await options.readFile(entry) : undefined;
        result.push(content === undefined ? entry : await documentApi(entry, content));
      }
      return filterResourceEntries(result, query);
    },
    definition: async (id) => {
      const entry = (await entries(["api", "mcp", "rule", "skill"])).find(candidate => candidate.id === id);
      if (!entry) return undefined;
      const content = await options.readFile(entry);
      return content === undefined ? undefined : { entry: await documentApi(entry, content, true), content };
    }
  };
}


/** The APIs page adds callable contracts and language references to the file API directory. */
export function createApiDataSource(options: ApiDataSourceOptions): ResourceEditorDataSource {
  const catalog = async (): Promise<ResourceEntry[]> => [
    ...options.methods().map(apiEntry),
    ...apiReferenceEntries(await options.reference?.())
  ];
  return {
    list: async (kinds, query) => {
      if (!kinds.includes("api")) return [];
      const [documented, files] = await Promise.all([catalog(), options.files?.list(["api"], query) ?? []]);
      const ids = new Set(documented.map(entry => entry.id));
      // Preserve the built-in reference when a user module is also named ask.ts, etc.
      return filterResourceEntries([
        ...documented,
        ...files.map(entry => ids.has(entry.id) ? { ...entry, id: `file:${entry.id}` } : entry)
      ], query);
    },
    definition: async (id) => {
      const entry = (await catalog()).find(candidate => candidate.id === id);
      if (entry) return { entry, content: "" };
      const file = await options.files?.definition(id.startsWith("file:") ? id.slice(5) : id);
      return file ? { ...file, entry: { ...file.entry, id } } : undefined;
    }
  };
}
