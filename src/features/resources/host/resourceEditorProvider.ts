import type { ApiReferenceCatalog, ApiReferenceModule } from "../../workflow/contracts/apiReference.js";
import { CONVERSATION_METHODS, formatFieldType, formatMethodParameter, methodResultType } from "../../workflow/domain/methodSignature.js";
import { editorTabKey } from "../../../platform/editor-tabs/editorTabTypes.js";
import type { ApiCallable, ApiDataSourceOptions, FileResourceDataSourceOptions, ResourceEditorDataSource, ResourceEditorProviderOptions, ResourceEditorShowResult, ResourceEntry } from "../contracts/resourceDocuments.js";
import { RESOURCE_DIRECTORIES, resourceDirectorySegments, type ResourceKind, type ResourceScope } from "../contracts/resourceSession.js";
import { filterResourceEntries, resourceEntryId } from "../presentation/resourceDocuments.js";


/**
 * Editor-tab behavior shared by the Resources pages: the stable key and the message routing.
 * A page decides what its list and its detail show.
 */
export abstract class ResourceEditorProvider {
  protected readonly listKey: string;

  constructor(protected readonly options: ResourceEditorProviderOptions) {
    this.listKey = editorTabKey("globalResources", options.scopeKey ? { scope: options.scopeKey } : {});
  }

  get listTabKey(): string {
    return this.listKey;
  }

  abstract showList(query?: string): Promise<ResourceEditorShowResult>;

  abstract showDetail(id: string): Promise<ResourceEditorShowResult>;

  /** Handles list search, open, refresh and toolbar commands routed by the shared manager. */
  async handleMessage(key: string, message: unknown): Promise<void> {
    if (key !== this.listKey && this.options.manager.get(key)?.kind !== "globalResources") return;
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

  /** Kinds shown by the list page. A page that lists several categories overrides this. */
  protected listKinds(): readonly ResourceKind[] {
    return [this.primaryKind()];
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
    source: { kind: "directory" }
  };
}


/** A one-line summary for a reference module's list row: the declaration's own
 * first paragraph, or how many members it carries. The row's signature lines
 * already cover a module with a single member. */
export function referenceSummary(module: ApiReferenceModule): string {
  const text = module.documentation?.split("\n\n")[0]?.replace(/\s+/g, " ").trim();
  if (text) return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
  return module.members.length > 1 ? `${module.members.length} members from the TypeScript declaration` : "";
}


/** A Node module or JavaScript global as a read-only entry. It is an API page row
 * with no callable contract, so it carries the declaration's own documentation. */
export function apiReferenceEntry(module: ApiReferenceModule): ResourceEntry {
  const path = `${module.id}.json`;
  const summary = referenceSummary(module);
  return {
    id: resourceEntryId({ kind: "api", scope: "global", path }),
    kind: "api",
    scope: "global",
    name: module.id,
    displayName: module.name,
    path,
    group: module.family,
    ...(summary ? { description: summary } : {}),
    reference: module,
    // A reference entry ships inside the extension's own declarations rather than
    // in a resource directory, so it is listed but not editable or openable.
    source: { kind: "directory" }
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
          source: { kind: file.scope, path: `${directory}/${RESOURCE_DIRECTORIES[kind]}/${file.path}` }
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
    const leaf = entry.name.split(".").at(-1);
    const apiFlow = includeFlow && options.describeApiFlow ? await options.describeApiFlow(content, leaf) : undefined;
    if (!functions.length) return apiFlow ? { ...entry, apiFlow } : entry;
    const apiFunctions = functions.map(item => ({ ...item,
      name: [leaf, "default"].includes(item.name) ? entry.name : `${entry.name}.${item.name}`
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
        if (content === undefined) { result.push(entry); continue; }
        const documented = await documentApi(entry, content);
        // A Dext API exports the function its file names; a module that exports only
        // helpers is imported rather than run, so the page lists APIs only.
        if (!documented.apiFunctions?.some(item => item.name === entry.name)) continue;
        result.push(documented);
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


/** The built-in callable APIs and language references Dext ships its own page from. */
export function createApiDataSource(options: ApiDataSourceOptions): ResourceEditorDataSource {
  const catalog = async (): Promise<ResourceEntry[]> => [
    ...options.methods().filter((method) => method.source === "builtin").map(apiEntry),
    ...apiReferenceEntries(await options.reference?.())
  ];
  return {
    list: async (kinds, query) => kinds.includes("api") ? filterResourceEntries(await catalog(), query) : [],
    definition: async (id) => {
      const entry = (await catalog()).find(candidate => candidate.id === id);
      return entry ? { entry, content: "" } : undefined;
    }
  };
}
