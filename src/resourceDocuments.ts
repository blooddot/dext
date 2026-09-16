import { RESOURCE_DIRECTORIES, RESOURCE_LABELS, type ResourceKind, type ResourceScope } from "./resourceSession.js";
import { editorTabKey } from "./editorTabTypes.js";
import type { EditorTabState } from "./editorTabState.js";
import { describeEditorTab, type EditorTabManager } from "./editorTabManager.js";
import type { EditorTabRestorer } from "./editorTabSerializer.js";
import type { SidebarState } from "./webviewProtocol.js";
import { formatFieldType, formatMethodParameter, methodResultType } from "./core/methodSignature.js";
import { parser as pythonParser } from "@lezer/python";
import { highlightCode } from "@lezer/highlight";
import { dextClassHighlighter } from "./dextTokenTheme.js";
import { resourceIcon } from "./resourceIcons.js";

export interface ResourceSourceRef {
  kind: "project" | "global" | "directory";
  label: string;
  path?: string;
}

export interface ResourceEntry {
  id: string;
  kind: ResourceKind;
  scope: ResourceScope;
  name: string;
  /** Relative path inside the resource directory. */
  path: string;
  source: ResourceSourceRef;
  group: string;
  description?: string;
  api?: {
    signature: string;
    parameters: Array<{ name: string; type: string; required: boolean; defaultValue?: string; description?: string }>;
    returnType: string;
  };
}

export interface ResourceListDocument {
  kind: ResourceKind;
  scope: ResourceScope;
  entries: ResourceEntry[];
  groups: Array<{ label: string; entries: ResourceEntry[] }>;
  query: string;
}

export interface ResourceDefinitionDocument {
  entry: ResourceEntry;
  content: string;
  source: ResourceSourceRef;
}

export function resourceEntryId(entry: Pick<ResourceEntry, "kind" | "scope" | "path">): string {
  return `${entry.kind}:${entry.scope}:${entry.path}`;
}

/** Groups entries by their parent directory so nested API namespaces stay readable. */
export function groupResourceEntries(entries: readonly ResourceEntry[], groupBy: "directory" | "kind" = "directory"): Array<{ label: string; entries: ResourceEntry[] }> {
  const groups = new Map<string, ResourceEntry[]>();
  for (const entry of entries) {
    const label = groupBy === "kind" ? RESOURCE_LABELS[entry.kind] : entry.group;
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  return [...groups.entries()]
    .map(([label, value]) => ({ label, entries: [...value].sort((left, right) => left.name.localeCompare(right.name)) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** Search matches the name and the declared description; an empty query keeps every entry. */
export function filterResourceEntries(entries: readonly ResourceEntry[], query: string): ResourceEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) =>
    entry.name.toLocaleLowerCase().includes(needle)
    || (entry.description ?? "").toLocaleLowerCase().includes(needle));
}

export function buildResourceList(input: {
  kind: ResourceKind;
  scope: ResourceScope;
  entries: readonly ResourceEntry[];
  query?: string;
  groupBy?: "directory" | "kind";
}): ResourceListDocument {
  const filtered = filterResourceEntries(input.entries, input.query ?? "");
  return {
    kind: input.kind,
    scope: input.scope,
    entries: filtered,
    groups: groupResourceEntries(filtered, input.groupBy ?? "directory"),
    query: input.query ?? ""
  };
}

export function buildResourceDefinition(entry: ResourceEntry, content: string): ResourceDefinitionDocument {
  return { entry, content, source: entry.source };
}

/**
 * Applies the user's edit if the file still matches the version it was opened at. A conflict is
 * reported with the current content instead of overwriting someone else's edit.
 */
export function applyResourceEdit(
  document: ResourceDefinitionDocument,
  nextContent: string,
  currentContent: string
): { status: "applied"; content: string } | { status: "unchanged"; content: string } | { status: "conflict"; content: string } {
  if (currentContent === nextContent) return { status: "unchanged", content: currentContent };
  if (currentContent !== document.content) return { status: "conflict", content: currentContent };
  return { status: "applied", content: nextContent };
}

export function escapeResourceHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

export interface ResourcePanelOptions {
  /** Base command prefix used for source jumps and the existing edit flows. */
  commandPrefix?: string;
  title?: string;
  createKinds?: readonly ResourceKind[];
  scope?: ResourceScope;
  availableScopes?: readonly ResourceScope[];
  collapsed?: readonly string[];
  apiTree?: boolean;
  navigation?: { canGoBack: boolean; canGoForward: boolean; label?: string; scrollTop: number };
  /** Tab state persisted through `setState`, so a reload restores this exact page. */
  tabState?: EditorTabState;
}

function renderResourceNavigation(options: ResourcePanelOptions): string {
  const navigation = options.navigation;
  if (!navigation) return "";
  const scope = options.scope && options.availableScopes?.length
    ? `<span class="resource-scope-switch" role="group" aria-label="Resource scope">${options.availableScopes.map((value) => `<button type="button" data-resource-scope="${value}" class="${value === options.scope ? "is-active" : ""}">${value === "global" ? "Global" : "Project"}</button>`).join("")}</span>` : "";
  return `<nav class="resource-navigation" aria-label="Resource navigation" data-resource-scroll="${navigation.scrollTop}">`
    + `<button type="button" data-resource-navigate="back" aria-label="Back" title="Back"${navigation.canGoBack ? "" : " disabled"}>←</button>`
    + `<button type="button" data-resource-navigate="forward" aria-label="Forward" title="Forward"${navigation.canGoForward ? "" : " disabled"}>→</button>`
    + `<button type="button" class="resource-navigation-home" data-resource-navigate="home">${options.title === "Resources" ? "Resources" : "APIs"}</button>`
    + (navigation.label ? `<span aria-hidden="true">/</span><span class="resource-navigation-current" aria-current="page">${escapeResourceHtml(navigation.label)}</span>` : "")
    + scope + `</nav>`;
}

function highlightResourceSource(source: string): string {
  let html = "";
  try {
    highlightCode(source, pythonParser.parse(source), dextClassHighlighter,
      (value, classes) => { html += classes ? `<span class="${classes}">${escapeResourceHtml(value)}</span>` : escapeResourceHtml(value); },
      () => { html += "\n"; });
    return html;
  } catch { return escapeResourceHtml(source); }
}

function apiDisplayName(entry: ResourceEntry): string {
  return entry.kind === "api" ? entry.name.split(".").at(-1)! : entry.name;
}

function highlightApiType(type: string): string {
  return [...type.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][\w.]*|[^A-Za-z_'"]+/g)]
    .map(([token]) => /^['"]/.test(token) ? `<span class="tok-string">${escapeResourceHtml(token)}</span>`
      : /^[A-Za-z_]/.test(token) ? `<span class="tok-typeName">${escapeResourceHtml(token)}</span>` : escapeResourceHtml(token)).join("");
}

/** Signatures use metadata: optional markers are Dext syntax, not valid Python expressions. */
function renderApiSignature(entry: ResourceEntry, shortName = false): string {
  const api = entry.api;
  if (!api) return escapeResourceHtml(entry.name);
  return `<span class="tok-function">${escapeResourceHtml(shortName ? apiDisplayName(entry) : entry.name)}</span>(`
    + api.parameters.map((parameter) => `<span class="tok-propertyName">${escapeResourceHtml(parameter.name)}</span>${parameter.required ? "" : "?"}: ${highlightApiType(parameter.type)}`
      + (parameter.defaultValue === undefined ? "" : ` = ${highlightResourceSource(parameter.defaultValue === "true" ? "True" : parameter.defaultValue === "false" ? "False" : parameter.defaultValue)}`)).join(", ")
    + `) -&gt; ${highlightApiType(api.returnType)}`;
}

function resourceToggleButton(attributes: string, label: string, expanded: boolean): string {
  const title = `${expanded ? "Collapse" : "Expand"} ${label}`;
  return `<button type="button" class="resource-icon-button" ${attributes} data-resource-toggle-label="${escapeResourceHtml(label)}" title="${escapeResourceHtml(title)}" aria-label="${escapeResourceHtml(title)}" aria-expanded="${expanded}">`
    + `<span data-resource-icon="collapse-all"${expanded ? "" : " hidden"}>${resourceIcon("collapse-all")}</span>`
    + `<span data-resource-icon="expand-all"${expanded ? " hidden" : ""}>${resourceIcon("expand-all")}</span></button>`;
}

function resourceRefreshButton(prefix: string): string {
  return `<button type="button" class="resource-icon-button" data-resource-command="${prefix}.reloadMethods" title="Refresh" aria-label="Refresh">${resourceIcon("refresh")}</button>`;
}

interface ApiTreeNode { name: string; path: string; entries: ResourceEntry[]; children: Map<string, ApiTreeNode>; }

function countApiTreeEntries(node: ApiTreeNode): number {
  return node.entries.length + [...node.children.values()].reduce((total, child) => total + countApiTreeEntries(child), 0);
}

function renderApiTree(document: ResourceListDocument, collapsed: Set<string>): string {
  const root: ApiTreeNode = { name: "", path: ".", entries: [], children: new Map() };
  for (const group of document.groups) {
    const parts = group.label === "." ? [] : group.label.split(".");
    let node = root;
    for (const part of parts) {
      const path = node.path === "." ? part : `${node.path}.${part}`;
      node.children.set(part, node.children.get(part) ?? { name: part, path, entries: [], children: new Map() });
      node = node.children.get(part)!;
    }
    node.entries.push(...group.entries);
  }
  const entryHtml = (entry: ResourceEntry): string => `<li class="resource-entry" data-resource-search-text="${escapeResourceHtml(`${entry.name} ${entry.description ?? ""} ${entry.api?.signature ?? ""}`)}" data-resource-id="${escapeResourceHtml(resourceEntryId(entry))}"><button type="button" data-resource-open="${escapeResourceHtml(resourceEntryId(entry))}"><span class="resource-entry-heading"><span class="resource-name">${escapeResourceHtml(apiDisplayName(entry))}</span><span class="resource-source">${escapeResourceHtml(entry.source.label)}</span></span>${entry.api ? `<code class="resource-entry-signature">${renderApiSignature(entry, true)}</code>` : ""}${entry.description ? `<span class="resource-description">${escapeResourceHtml(entry.description)}</span>` : ""}</button></li>`;
  const renderNode = (node: ApiTreeNode): string => `<details class="resource-group resource-api-node" data-resource-group="${escapeResourceHtml(node.path)}" data-resource-node="${escapeResourceHtml(node.path)}" data-resource-type="api"${collapsed.has(node.path) ? "" : " open"}><summary><span class="resource-group-toggle" data-resource-toggle="${escapeResourceHtml(node.path)}">${escapeResourceHtml(node.name)}</span><span class="resource-count">${countApiTreeEntries(node)}</span><span class="resource-group-chevron" aria-hidden="true">⌄</span></summary><ul>${node.entries.sort((a, b) => a.name.localeCompare(b.name)).map(entryHtml).join("")}${[...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map(renderNode).join("")}</ul></details>`;
  // Keep the synthetic Top level group limited to APIs without a namespace. Namespace
  // groups such as node and ui are siblings of it, rather than nested beneath it.
  const topLevel = root.entries.sort((a, b) => a.name.localeCompare(b.name));
  const topLevelHtml = `<details class="resource-group resource-api-node" data-resource-group="." data-resource-node="." data-resource-type="api"${collapsed.has(".") ? "" : " open"}><summary><span class="resource-group-toggle" data-resource-toggle=".">Top level</span><span class="resource-count">${topLevel.length}</span><span class="resource-group-chevron" aria-hidden="true">⌄</span></summary><ul>${topLevel.map(entryHtml).join("")}</ul></details>`;
  return topLevelHtml + [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map(renderNode).join("");
}

/**
 * Filter the loaded list in place so typing keeps focus; forward open and toolbar commands.
 */
export function resourceClientScript(state?: EditorTabState): string {
  const restore = state ? `api.setState(${JSON.stringify(state)});` : "";
  return `<script>(function(){
    var api=window.__dextApi||(window.__dextApi=acquireVsCodeApi());${restore}
    var collapsed=new Set((document.body.dataset.resourceCollapsed||'').split('\\u001f').filter(Boolean));
    function nodes(){return Array.from(document.querySelectorAll('[data-resource-node]'));}
    function search(){return document.querySelector('[data-resource-search]');}
    function query(){var input=search();return input?input.value.trim().toLocaleLowerCase():'';}
    function viewState(){var input=search();return {query:input?input.value:undefined,scrollTop:window.scrollY,collapsed:Array.from(collapsed)};}
    function targets(button){
      var id=button.getAttribute('data-resource-group-target');
      if(!id)return nodes();
      var group=nodes().find(function(node){return node.getAttribute('data-resource-node')===id;});
      return group?[group].concat(Array.from(group.querySelectorAll('[data-resource-node]'))):[];
    }
    function expanded(button){
      var groups=targets(button);
      if(button.hasAttribute('data-resource-group-target'))return !!groups[0]&&groups[0].open;
      return groups.filter(function(group){return !group.parentElement.closest('[data-resource-node]');}).some(function(group){return group.open;});
    }
    function syncButtons(){
      document.querySelectorAll('[data-resource-toggle-label]').forEach(function(button){
        var open=expanded(button),label=(open?'Collapse ':'Expand ')+button.getAttribute('data-resource-toggle-label');
        button.title=label;button.setAttribute('aria-label',label);button.setAttribute('aria-expanded',String(open));
        button.querySelector('[data-resource-icon="collapse-all"]').hidden=!open;
        button.querySelector('[data-resource-icon="expand-all"]').hidden=open;
      });
    }
    function setOpen(node,open){
      node.open=open;var id=node.getAttribute('data-resource-node');
      if(open)collapsed.delete(id);else collapsed.add(id);
    }
    document.addEventListener('click',function(event){
      var element=event.target.closest('[data-resource-command],[data-resource-open],[data-resource-navigate],[data-resource-toggle],[data-resource-toggle-all],[data-resource-group-action],button[data-resource-scope]');
      if(!element||element.disabled)return;
      if(element.hasAttribute('data-resource-toggle-all')||element.hasAttribute('data-resource-group-action')){
        event.preventDefault();var open=!expanded(element);targets(element).forEach(function(node){setOpen(node,open);});syncButtons();return;
      }
      var nodeId=element.getAttribute('data-resource-toggle');
      if(nodeId){event.preventDefault();var node=nodes().find(function(item){return item.getAttribute('data-resource-node')===nodeId;});if(node)setOpen(node,!node.open);syncButtons();return;}
      var scope=element.getAttribute('data-resource-scope');
      if(scope){api.postMessage({type:'resourceScope',scope:scope,viewState:viewState()});return;}
      var direction=element.getAttribute('data-resource-navigate'),command=element.getAttribute('data-resource-command'),id=element.getAttribute('data-resource-open');
      var message=direction?{type:'resourceNavigate',direction:direction}:command?{
        type:'resourceCommand',command:command,kind:element.getAttribute('data-resource-kind')||undefined,
        path:element.getAttribute('data-resource-path')||undefined,id:element.getAttribute('data-resource-id')||undefined
      }:id?{type:'resourceOpen',id:id}:null;
      if(message){if(document.querySelector('.resource-navigation'))message.viewState=viewState();api.postMessage(message);}
    });
    document.addEventListener('toggle',function(event){
      var node=event.target;if(!node.matches('[data-resource-node]'))return;
      if(!query()){var id=node.getAttribute('data-resource-node');if(node.open)collapsed.delete(id);else collapsed.add(id);}
      syncButtons();
    },true);
    function filter(){
      var needle=query(),total=0;
      document.querySelectorAll('[data-resource-search-text]').forEach(function(row){
        row.hidden=!(row.getAttribute('data-resource-search-text')||'').toLocaleLowerCase().includes(needle);if(!row.hidden)total++;
      });
      nodes().forEach(function(group){
        var count=group.querySelectorAll('[data-resource-search-text]:not([hidden])').length;
        group.hidden=!!needle&&!count;
        group.open=needle?count>0:!collapsed.has(group.getAttribute('data-resource-node'));
        var badge=group.querySelector(':scope > summary .resource-count');if(badge)badge.textContent=String(count);
      });
      var empty=document.querySelector('[data-resource-no-results]');if(empty)empty.hidden=!needle||total>0;
      syncButtons();
    }
    document.addEventListener('input',function(event){if(event.target.matches('[data-resource-search]'))filter();});
    filter();
    var navigation=document.querySelector('[data-resource-scroll]');
    if(navigation)requestAnimationFrame(function(){window.scrollTo(0,Number(navigation.getAttribute('data-resource-scroll'))||0);});
  })();</script>`;
}
/** Renders the list page for API or Global Resources, preserving search, grouping and refresh. */
export function renderResourceList(document: ResourceListDocument, options: ResourcePanelOptions = {}): string {
  const prefix = options.commandPrefix ?? "dext";
  const collapsed = new Set(options.collapsed ?? []);
  const groups = options.apiTree ? renderApiTree(document, collapsed) : document.groups.map((group) => `<details class="resource-group" data-resource-group="${escapeResourceHtml(group.label)}" data-resource-node="${escapeResourceHtml(group.label)}"${collapsed.has(group.label) ? "" : " open"} data-resource-type="${document.kind === "api" ? "api" : (options.createKinds?.find((kind) => RESOURCE_LABELS[kind] === group.label) ?? "")}">`
    + `<summary><span class="resource-group-toggle" data-resource-toggle="${escapeResourceHtml(group.label)}">${escapeResourceHtml(group.label === "." ? "Top level" : group.label)}</span><span class="resource-count">${group.entries.length}</span>${options.createKinds ? `<span class="resource-group-actions">${resourceToggleButton(`data-resource-group-action="toggle" data-resource-group-target="${escapeResourceHtml(group.label)}"`, group.label, !collapsed.has(group.label))}</span>` : ""}<span class="resource-group-chevron" aria-hidden="true">⌄</span></summary><ul>`
    + group.entries.map((entry) => `<li class="resource-entry" data-resource-search-text="${escapeResourceHtml(`${entry.name} ${entry.description ?? ""}`)}" data-resource-id="${escapeResourceHtml(resourceEntryId(entry))}" data-resource-path="${escapeResourceHtml(entry.path)}">`
      + `<button type="button" data-resource-open="${escapeResourceHtml(resourceEntryId(entry))}"><span class="resource-entry-heading"><span class="resource-name">${escapeResourceHtml(entry.name)}</span>`
      + `<span class="resource-source">${escapeResourceHtml(entry.source.label)}</span></span>`
      + (entry.description ? `<span class="resource-description">${escapeResourceHtml(entry.description)}</span>` : "") + `</button>`
      + `</li>`).join("")
    + `</ul>${group.entries.length ? "" : `<p class="resource-empty">No ${escapeResourceHtml(group.label)} resources found.</p>`}</details>`).join("");
  return `<div class="resource-panel" data-resource-kind="${document.kind}" data-resource-scope="${document.scope}">`
    + renderResourceNavigation(options)
    + `<h1>${escapeResourceHtml(options.title ?? (document.kind === "api" ? "APIs" : RESOURCE_LABELS[document.kind]))}</h1>`
    + `<header class="resource-toolbar">`
    + `<input type="search" data-resource-search value="${escapeResourceHtml(document.query)}" placeholder="Search by name or description" aria-label="Search resources">`
    + resourceRefreshButton(prefix)
    + (options.createKinds ? "" : `<span class="resource-tree-actions">${resourceToggleButton('data-resource-toggle-all="toggle"', "all", true)}</span>`)
    + (options.createKinds?.map((kind) => `<button type="button" class="resource-create" data-resource-command="${prefix}.newResource" data-resource-kind="${kind}" data-resource-type="${kind}">New ${RESOURCE_LABELS[kind]}</button>`).join("") ?? "")
    + `</header>`
    + (groups || `<p class="resource-empty">No ${escapeResourceHtml(RESOURCE_LABELS[document.kind])} resources found.</p>`)
    + `<p class="resource-empty" data-resource-no-results hidden>No matching resources.</p>`
    + `</div><script>document.body.dataset.resourceCollapsed=${JSON.stringify([...collapsed].join("\u001f"))};</script>${resourceClientScript(options.tabState)}`;
}

/** A resource that disappeared keeps its stable key and shows a recoverable error instead. */
export function renderResourceError(id: string, message: string, options: ResourcePanelOptions = {}): string {
  const prefix = options.commandPrefix ?? "dext";
  return `<div class="resource-panel resource-error" data-resource-id="${escapeResourceHtml(id)}" data-resource-error="1">`
    + renderResourceNavigation(options)
    + `<p>${escapeResourceHtml(message)}</p>`
    + resourceRefreshButton(prefix) + `</div>${resourceClientScript(options.tabState)}`;
}

/** Renders one resource definition with its originating file for the source jump. */export function renderResourceDefinition(document: ResourceDefinitionDocument, options: ResourcePanelOptions = {}): string {
  const prefix = options.commandPrefix ?? "dext";
  const { entry } = document;
  const api = entry.kind === "api" ? entry.api : undefined;
  const highlightedApiSignature = renderApiSignature(entry);
  const resultTitle = api ? ` title="${escapeResourceHtml(`Returned by ${api.signature}`)}"` : "";
  const apiDetails = api
    ? `<section class="resource-api-docs"><p class="resource-api-signature"><code>${highlightedApiSignature}</code></p><h3>Parameters</h3><dl>${(api.parameters.length ? api.parameters : [{ name: "", type: "", required: true, description: "This API takes no parameters." }]).map((parameter) => parameter.name
      ? `<div><dt><code class="tok-propertyName">${escapeResourceHtml(parameter.name)}</code> <code class="resource-api-type">${highlightApiType(parameter.type)}</code>${parameter.required ? "" : " <em>(optional)</em>"}</dt><dd>${escapeResourceHtml(parameter.description ?? "No description provided.")}${parameter.defaultValue !== undefined ? ` <span class="resource-api-default">Default: <code>${highlightResourceSource(parameter.defaultValue)}</code></span>` : ""}</dd></div>`
      : `<p>${escapeResourceHtml(parameter.description ?? "")}</p>`).join("")}</dl><h3>Returns</h3><p><code class="resource-result-type"${resultTitle}>${highlightApiType(api.returnType)}</code></p></section>`
    : "";
  return `<div class="resource-definition" data-resource-id="${escapeResourceHtml(resourceEntryId(entry))}">`
    + renderResourceNavigation(options)
    + `<header class="resource-toolbar"><h2>${escapeResourceHtml(entry.name)}</h2>`
    + (entry.source.path ? `<button type="button" data-resource-command="${prefix}.openResourceSource" data-resource-path="${escapeResourceHtml(entry.source.path)}">Open source</button>` : "")
    + `<button type="button" data-resource-command="${prefix}.insertResourceReference" data-resource-id="${escapeResourceHtml(resourceEntryId(entry))}">Insert reference</button>`
    + `</header>${apiDetails}<h3 class="resource-source-heading">Source</h3><pre class="resource-content" data-resource-source="${escapeResourceHtml(document.content)}"><code>${highlightResourceSource(document.content)}</code></pre></div>${resourceClientScript(options.tabState)}`;
}

export interface ResourceEditorDataSource {
  /** Lists every entry whose kind is requested; a multi-kind page reports its own categories. */
  list(kinds: readonly ResourceKind[], query: string): Promise<readonly ResourceEntry[]>;
  definition(id: string): Promise<{ entry: ResourceEntry; content: string } | undefined>;
}

export interface ResourceEditorProviderOptions {
  manager: EditorTabManager;
  restorer: EditorTabRestorer;
  dataSource: ResourceEditorDataSource;
  scope: ResourceScope;
  /** Main workspace root, used to keep tabs distinct across roots. */
  scopeKey?: string;
  availableScopes?(): readonly ResourceScope[];
  commandPrefix?: string;
  /** Runs a toolbar command such as a source jump, reference insertion, or refresh. */
  onCommand?(command: string, payload: { id?: string; kind?: string; path?: string; query?: string; scope?: ResourceScope }): Promise<void> | void;
  /** Page renderers. The migrated API and Global Resources pages override these. */
  renderList?: (document: ResourceListDocument, options: ResourcePanelOptions) => string;
  renderDetail?: (document: ResourceDefinitionDocument, options: ResourcePanelOptions) => string;
}

export interface ResourceEditorShowResult {
  key: string;
  created: boolean;
}

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
    const payload = (message ?? {}) as { type?: unknown; id?: unknown; kind?: unknown; path?: unknown; query?: unknown };
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
      await this.options.onCommand?.(command, {
        ...(typeof payload.id === "string" ? { id: payload.id } : {}),
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
        ...(typeof payload.path === "string" ? { path: payload.path } : {}),
        ...(typeof payload.query === "string" ? { query: payload.query } : {})
      });
      if (command === `${this.options.commandPrefix ?? "dext"}.reloadMethods`) {
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

export interface SidebarResourceDataSourceOptions {
  /** Current sidebar state. Methods and global resources already describe every resource. */
  state(): SidebarState;
  /** Reads the file behind one entry. Missing files fall back to a generated summary. */
  readFile?(entry: ResourceEntry): Promise<string | undefined>;
}

function apiEntry(method: SidebarState["methods"][number], roots: SidebarState["resourceRoots"]): ResourceEntry {
  const scope: ResourceScope = method.source === "project" ? "project" : "global";
  const path = `${method.id.replaceAll(".", "/")}.dx`;
  const directory = method.source === "builtin" ? "" : roots?.[scope] ?? "";
  const fields = (method.input ?? []).filter((field) => !field.internal);
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
    // A built-in API ships inside the extension bundle, so it has no project or global source file.
    source: {
      kind: method.source === "builtin" ? "directory" : scope,
      label: method.source,
      ...(directory ? { path: `${directory}/${RESOURCE_DIRECTORIES.api}/${path}` } : {})
    }
  };
}

function globalEntry(item: { name: string; detail?: string }, kind: Exclude<ResourceKind, "api">, roots: SidebarState["resourceRoots"]): ResourceEntry {
  const path = kind === "mcp" ? `${item.name}.jsonc` : kind === "skill" ? `${item.name}/SKILL.md` : item.name.endsWith(".md") ? item.name : `${item.name}.md`;
  const directory = roots?.global ?? "";
  return {
    id: resourceEntryId({ kind, scope: "global", path }),
    kind,
    scope: "global",
    name: item.name,
    path,
    group: RESOURCE_LABELS[kind],
    ...(item.detail ? { description: item.detail } : {}),
    source: { kind: "global", label: "Global", ...(directory ? { path: `${directory}/${RESOURCE_DIRECTORIES[kind]}/${path}` } : {}) }
  };
}

/** Builds tab documents from the sidebar state, so search, grouping, detail and jumps stay identical. */
export function createSidebarResourceDataSource(options: SidebarResourceDataSourceOptions): ResourceEditorDataSource {
  const entries = (): ResourceEntry[] => {
    const state = options.state();
    const roots = state.resourceRoots;
    const resources = state.globalResources ?? { apis: [], mcps: [], rules: [], skills: [] };
    return [
      ...state.methods.map((method) => apiEntry(method, roots)),
      ...resources.mcps.map((item) => globalEntry(item, "mcp", roots)),
      ...resources.rules.map((item) => globalEntry(item, "rule", roots)),
      ...resources.skills.map((item) => globalEntry(item, "skill", roots))
    ];
  };
  return {
    list: (kinds, query) => Promise.resolve(filterResourceEntries(entries().filter((entry) => kinds.includes(entry.kind)), query)),
    definition: async (id) => {
      const entry = entries().find((candidate) => candidate.id === id);
      if (!entry) return undefined;
      const content = await options.readFile?.(entry);
      return { entry, content: content ?? `${entry.name}\n${entry.description ?? ""}`.trim() };
    }
  };
}



