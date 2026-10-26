import type { ApiReferenceMember, ApiReferenceModule } from "../../workflow/contracts/apiReference.js";
import type { EditorTabState } from "../../../platform/editor-tabs/editorTabState.js";
import type { ResourceDefinitionDocument, ResourceEntry, ResourceListDocument, ResourcePanelOptions, ResourceTreeNode } from "../contracts/resourceDocuments.js";
import { RESOURCE_LABELS, resourceDirectorySegments, type ResourceKind, type ResourceScope } from "../contracts/resourceSession.js";
import { renderApiFlow } from "./apiFlowDiagram.js";
import { resourceIcon } from "./resourceIcons.js";


export function resourceEntryId(entry: Pick<ResourceEntry, "kind" | "scope" | "path">): string {
  return `${entry.kind}:${entry.scope}:${entry.path}`;
}


/** An MCP tool is registered as the `mcp.<server>.<tool>` API, so its id starts with the MCP root. */
export function isMcpApiId(id: string): boolean {
  return /^mcp\.[^.]+\./.test(id);
}


/**
 * The category an entry belongs to on the Resources page. MCP tools are callable APIs, but they
 * belong to the MCP category rather than the API directory.
 */
export function resourceCategory(entry: Pick<ResourceEntry, "kind" | "name">): ResourceKind {
  return entry.kind === "api" && isMcpApiId(entry.name) ? "mcp" : entry.kind;
}


/** Maps a rendered category label back to its resource kind. */
export function resourceKindForLabel(label: string): ResourceKind | undefined {
  return (Object.keys(RESOURCE_LABELS) as ResourceKind[]).find((kind) => RESOURCE_LABELS[kind] === label);
}


/**
 * Tree levels for one entry inside a category. APIs nest by their dotted namespace;
 * file resources nest by the directories they live in, so `rules/git/commit.md` reads
 * as `git` with `commit` beneath it. An MCP tool drops the `mcp` root the category names.
 */
export function categoryTreePath(entry: ResourceEntry, kind: ResourceKind | undefined): string[] {
  if (entry.kind !== "api") return resourceDirectorySegments(entry.kind, entry.path);
  const namespace = entry.name.split(".").slice(0, -1);
  return kind === "mcp" && namespace[0] === "mcp" ? namespace.slice(1) : namespace;
}


/** Groups entries by their category or parent directory so nested namespaces stay readable. */
export function groupResourceEntries(entries: readonly ResourceEntry[], groupBy: "directory" | "kind" = "directory"): Array<{ label: string; entries: ResourceEntry[] }> {
  const groups = new Map<string, ResourceEntry[]>();
  for (const entry of entries) {
    const label = groupBy === "kind" ? RESOURCE_LABELS[resourceCategory(entry)] : entry.group;
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
    || (entry.description ?? "").toLocaleLowerCase().includes(needle)
    || (entry.apiFunctions?.map(item => item.api.signature).join(" ") ?? entry.api?.signature ?? "").toLocaleLowerCase().includes(needle));
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


export function escapeResourceHtml(value: string): string {
  return value.replace(/[&><"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}


export function renderResourceNavigation(options: ResourcePanelOptions): string {
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


/** Lightweight lexical colouring for the read-only source preview, shared by both pages. */
export function highlightResourceSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b|[^A-Za-z_$\d"'`/]+|./g, (token: string) => {
    const kind = token.startsWith("//") || token.startsWith("/*") ? "comment"
      : /^["'`]/.test(token) ? "string"
      : /^(?:import|from|export|default|async|await|function|return|const|let|var|if|else|throw|new|type|interface|extends|typeof|keyof|as|true|false|null|undefined)$/.test(token) ? "keyword"
      : /^(?:string|number|boolean|void|unknown|never|any|bigint|[A-Z][\w$]*)$/.test(token) ? "typeName"
      : /^\d/.test(token) ? "number" : undefined;
    const text = escapeResourceHtml(token);
    return kind ? `<span class="tok-${kind}">${text}</span>` : text;
  });
}


export function apiEntries(entry: ResourceEntry): ResourceEntry[] {
  return entry.apiFunctions?.length ? entry.apiFunctions.map(item => ({ ...entry, ...item, displayName: item.name.split(".").at(-1)! })) : [entry];
}


export function apiDisplayName(entry: ResourceEntry): string {
  if (entry.displayName) return entry.displayName;
  return entry.kind === "api" ? entry.name.split(".").at(-1)! : entry.name;
}


export function highlightApiType(type: string): string {
  return [...type.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][\w.]*|[^A-Za-z_'"]+/g)]
    .map(([token]) => /^['"]/.test(token) ? `<span class="tok-string">${escapeResourceHtml(token)}</span>`
      : /^[A-Za-z_]/.test(token) ? `<span class="tok-typeName">${escapeResourceHtml(token)}</span>` : escapeResourceHtml(token)).join("");
}


/** Both pages render signatures from callable or statically extracted file metadata. */
export function renderApiSignature(entry: ResourceEntry, shortName = false): string {
  const api = entry.api;
  if (!api) return escapeResourceHtml(entry.name);
  return `<span class="tok-function">${escapeResourceHtml(shortName ? apiDisplayName(entry) : entry.name)}</span>${api.typeParameters ? highlightApiType(api.typeParameters) : ""}(`
    + api.parameters.map((parameter) => `<span class="tok-propertyName">${escapeResourceHtml(parameter.name)}</span>${parameter.required ? "" : "?"}: ${highlightApiType(parameter.type)}`
      + (parameter.defaultValue === undefined ? "" : ` = ${highlightResourceSource(parameter.defaultValue)}`)).join(", ")
    + `) -&gt; ${highlightApiType(api.returnType)}`;
}


export function resourceToggleButton(attributes: string, label: string, expanded: boolean): string {
  const title = `${expanded ? "Collapse" : "Expand"} ${label}`;
  return `<button type="button" class="resource-icon-button" ${attributes} data-resource-toggle-label="${escapeResourceHtml(label)}" title="${escapeResourceHtml(title)}" aria-label="${escapeResourceHtml(title)}" aria-expanded="${expanded}">`
    + `<span data-resource-icon="collapse-all"${expanded ? "" : " hidden"}>${resourceIcon("collapse-all")}</span>`
    + `<span data-resource-icon="expand-all"${expanded ? " hidden" : ""}>${resourceIcon("expand-all")}</span></button>`;
}


export function resourceRefreshButton(prefix: string): string {
  return `<button type="button" class="resource-icon-button" data-resource-command="${prefix}.reloadMethods" title="Refresh" aria-label="Refresh">${resourceIcon("refresh")}</button>`;
}


export function countTreeNodeEntries(node: ResourceTreeNode): number {
  return node.entries.length + [...node.children.values()].reduce((total, child) => total + countTreeNodeEntries(child), 0);
}


export function newTreeNode(label: string, path: string): ResourceTreeNode {
  return { label, path, entries: [], children: new Map() };
}


/** Entries sharing a namespace branch are nested, so a dotted name becomes collapsible levels. */
export function buildResourceTree(root: ResourceTreeNode, entries: ReadonlyArray<{ entry: ResourceEntry; parts: readonly string[] }>): ResourceTreeNode {
  for (const { entry, parts } of entries) {
    let node = root;
    for (const part of parts) {
      // A "." root is the API page's top level, so its namespaces are not prefixed with it.
      const path = node.path === "." ? part : `${node.path}.${part}`;
      node.children.set(part, node.children.get(part) ?? newTreeNode(part, path));
      node = node.children.get(part)!;
    }
    node.entries.push(entry);
  }
  return root;
}


/** Every member name a reference module documents, nested members included, so a
 * search for `readFile` finds `node:fs/promises` rather than nothing. */
export function referenceMemberNames(members: readonly ApiReferenceMember[], names: string[] = []): string[] {
  for (const member of members) {
    names.push(member.name);
    if (member.members) referenceMemberNames(member.members, names);
  }
  return names;
}


/** The text one row is searched by. */
export function resourceSearchText(entry: ResourceEntry): string {
  return [entry.name, entry.description ?? "", entry.apiFunctions?.map(item => item.api.signature).join(" ") ?? entry.api?.signature ?? "", ...(entry.reference ? referenceMemberNames(entry.reference.members) : [])].join(" ");
}


export function renderTreeEntry(entry: ResourceEntry): string {
  return `<li class="resource-entry" data-resource-search-text="${escapeResourceHtml(resourceSearchText(entry))}" data-resource-id="${escapeResourceHtml(entry.id)}"><button type="button" data-resource-open="${escapeResourceHtml(entry.id)}"><span class="resource-entry-heading"><span class="resource-name">${escapeResourceHtml(apiDisplayName(entry))}</span><span class="resource-source">${escapeResourceHtml(entry.source.label)}</span></span>${entry.api ? `<code class="resource-entry-signature">${apiEntries(entry).map(item => renderApiSignature(item, true)).join("<br>")}</code>` : ""}${entry.description ? `<span class="resource-description">${escapeResourceHtml(entry.description)}</span>` : ""}</button></li>`;
}


export function renderTreeContents(node: ResourceTreeNode, collapsed: Set<string>, type: string): string {
  return [...node.entries].sort((left, right) => left.name.localeCompare(right.name)).map(renderTreeEntry).join("")
    + [...node.children.values()].sort((left, right) => left.label.localeCompare(right.label)).map((child) => renderTreeNode(child, collapsed, type)).join("");
}


export function renderTreeNode(node: ResourceTreeNode, collapsed: Set<string>, type: string): string {
  return `<details class="resource-group resource-api-node" data-resource-group="${escapeResourceHtml(node.path)}" data-resource-node="${escapeResourceHtml(node.path)}" data-resource-type="${escapeResourceHtml(type)}"${collapsed.has(node.path) ? "" : " open"}><summary><span class="resource-group-toggle" data-resource-toggle="${escapeResourceHtml(node.path)}">${escapeResourceHtml(node.label)}</span><span class="resource-count">${countTreeNodeEntries(node)}</span><span class="resource-group-chevron" aria-hidden="true">⌄</span></summary><ul>${renderTreeContents(node, collapsed, type)}</ul></details>`;
}


export function renderApiTree(document: ResourceListDocument, collapsed: Set<string>): string {
  const root = buildResourceTree(newTreeNode("", "."),
    document.groups.flatMap((group) => group.entries.map((entry) => ({ entry, parts: group.label === "." ? [] : group.label.split(".") }))));
  // Keep the synthetic Top level group limited to APIs without a namespace. Namespace
  // groups such as node and ui are siblings of it, rather than nested beneath it.
  const topLevel = `<details class="resource-group resource-api-node" data-resource-group="." data-resource-node="." data-resource-type="api"${collapsed.has(".") ? "" : " open"}><summary><span class="resource-group-toggle" data-resource-toggle=".">Top level</span><span class="resource-count">${root.entries.length}</span><span class="resource-group-chevron" aria-hidden="true">⌄</span></summary><ul>${root.entries.sort((left, right) => left.name.localeCompare(right.name)).map(renderTreeEntry).join("")}</ul></details>`;
  return topLevel + [...root.children.values()].sort((left, right) => left.label.localeCompare(right.label)).map((node) => renderTreeNode(node, collapsed, "api")).join("");
}


/**
 * The Resources page keeps one category per kind and nests each category's own namespaces, so
 * `dev.feat` reads as `dev` with `feat` beneath it instead of one flat list.
 */
export function renderCategoryTree(document: ResourceListDocument, collapsed: Set<string>): string {
  return document.groups.map((group) => {
    const kind = resourceKindForLabel(group.label);
    const type = kind ?? "";
    const root = buildResourceTree(newTreeNode("", group.label),
      group.entries.map((entry) => ({ entry, parts: categoryTreePath(entry, kind) })));
    return `<details class="resource-group" data-resource-group="${escapeResourceHtml(group.label)}" data-resource-node="${escapeResourceHtml(group.label)}" data-resource-type="${escapeResourceHtml(type)}"${collapsed.has(group.label) ? "" : " open"}>`
      + `<summary><span class="resource-group-toggle" data-resource-toggle="${escapeResourceHtml(group.label)}">${escapeResourceHtml(group.label)}</span><span class="resource-count">${group.entries.length}</span>`
      + `<span class="resource-group-actions">${resourceToggleButton(`data-resource-group-action="toggle" data-resource-group-target="${escapeResourceHtml(group.label)}"`, group.label, !collapsed.has(group.label))}</span>`
      + `<span class="resource-group-chevron" aria-hidden="true">⌄</span></summary><ul>${renderTreeContents(root, collapsed, type)}</ul>`
      + (group.entries.length ? "" : `<p class="resource-empty">No ${escapeResourceHtml(group.label)} resources found.</p>`) + `</details>`;
  }).join("");
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
    function announceCopy(button){
      var previous=button.textContent;button.textContent='Copied';
      setTimeout(function(){button.textContent=previous;},1200);
    }
    document.addEventListener('click',function(event){
      var element=event.target.closest('[data-resource-command],[data-resource-open],[data-resource-navigate],[data-resource-toggle],[data-resource-toggle-all],[data-resource-group-action],[data-resource-copy],button[data-resource-scope]');
      if(!element||element.disabled)return;
      var copied=element.getAttribute('data-resource-copy');
      if(copied){
        // The host owns the clipboard: a Webview cannot be relied on to reach it.
        event.preventDefault();
        if(document.querySelector('.resource-navigation'))api.postMessage({type:'resourceCopy',text:copied,viewState:viewState()});
        announceCopy(element);
        return;
      }
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
  const groups = options.apiTree ? renderApiTree(document, collapsed)
    : options.categoryTree ? renderCategoryTree(document, collapsed)
    : document.groups.map((group) => `<details class="resource-group" data-resource-group="${escapeResourceHtml(group.label)}" data-resource-node="${escapeResourceHtml(group.label)}"${collapsed.has(group.label) ? "" : " open"} data-resource-type="${document.kind === "api" ? "api" : (options.createKinds?.find((kind) => RESOURCE_LABELS[kind] === group.label) ?? "")}">`
    + `<summary><span class="resource-group-toggle" data-resource-toggle="${escapeResourceHtml(group.label)}">${escapeResourceHtml(group.label === "." ? "Top level" : group.label)}</span><span class="resource-count">${group.entries.length}</span>${options.createKinds ? `<span class="resource-group-actions">${resourceToggleButton(`data-resource-group-action="toggle" data-resource-group-target="${escapeResourceHtml(group.label)}"`, group.label, !collapsed.has(group.label))}</span>` : ""}<span class="resource-group-chevron" aria-hidden="true">⌄</span></summary><ul>`
    + group.entries.map((entry) => `<li class="resource-entry" data-resource-search-text="${escapeResourceHtml(`${entry.name} ${entry.description ?? ""}`)}" data-resource-id="${escapeResourceHtml(entry.id)}" data-resource-path="${escapeResourceHtml(entry.path)}">`
      + `<button type="button" data-resource-open="${escapeResourceHtml(entry.id)}"><span class="resource-entry-heading"><span class="resource-name">${escapeResourceHtml(entry.name)}</span>`
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


/** The sections a reference module's own members are grouped into, in reading order. */
export const REFERENCE_MEMBER_GROUPS: ReadonlyArray<{ label: string; kinds: readonly string[] }> = [
  { label: "Functions", kinds: ["function", "method"] },
  { label: "Classes", kinds: ["class"] },
  { label: "Namespaces and objects", kinds: ["namespace"] },
  { label: "Values", kinds: ["variable"] },
  { label: "Types", kinds: ["interface", "type", "enum"] }
];


/** One member of a reference module: its declaration's signature, the JSDoc that
 * documents it, and its own members — a class or namespace is a list inside a list. */
export function renderReferenceMember(member: ApiReferenceMember): string {
  const nested = member.members?.length
    ? `<ul class="resource-api-members">${member.members.map(renderReferenceMember).join("")}</ul>` : "";
  const documentation = member.documentation
    ? `<div class="resource-api-documentation">${escapeResourceHtml(member.documentation)}</div>` : "";
  const parameters = member.params?.length
    ? `<dl class="resource-api-params">${member.params.map((parameter) => `<div><dt><code>${escapeResourceHtml(parameter.name)}</code></dt><dd>${escapeResourceHtml(parameter.text)}</dd></div>`).join("")}</dl>` : "";
  const returns = member.returns
    ? `<p class="resource-api-returns"><span class="resource-api-tag">Returns</span> ${escapeResourceHtml(member.returns)}</p>` : "";
  const deprecated = member.deprecated
    ? `<p class="resource-api-deprecated"><span class="resource-api-tag">Deprecated</span> ${escapeResourceHtml(member.deprecated)}</p>` : "";
  const example = member.example
    ? `<pre class="resource-api-example"><code>${escapeResourceHtml(member.example)}</code></pre>` : "";
  return `<li class="resource-api-member" data-resource-member="${escapeResourceHtml(member.name)}">`
    + `<code class="resource-api-member-signature">${escapeResourceHtml(member.signature)}</code>`
    + documentation + parameters + returns + deprecated + example + nested + `</li>`;
}


/** A Node module or JavaScript global, rendered entirely from its own declaration:
 * the declaration's signature for every member and the JSDoc beside it. */
export function renderReferenceModule(module: ApiReferenceModule): string {
  // A Node global or a language global is one member named after the entry, so a
  // heading over a single row would only add noise.
  const single = module.members.length === 1 && module.members[0]!.name === module.name;
  const members = single
    ? `<ul class="resource-api-members">${renderReferenceMember(module.members[0]!)}</ul>`
    : REFERENCE_MEMBER_GROUPS.map((group) => {
      const entries = module.members.filter((member) => group.kinds.includes(member.kind));
      return entries.length
        ? `<h3>${escapeResourceHtml(group.label)}</h3><ul class="resource-api-members">${entries.map(renderReferenceMember).join("")}</ul>`
        : "";
    }).join("");
  const documentation = module.documentation
    ? `<div class="resource-api-documentation">${escapeResourceHtml(module.documentation)}</div>` : "";
  return `<section class="resource-api-reference">`
    + `<p class="resource-api-specifier"><code>${escapeResourceHtml(module.id)}</code>`
    + `<button type="button" class="resource-api-copy" data-resource-copy="${escapeResourceHtml(module.id)}">Copy</button></p>`
    + documentation + members + `</section>`;
}


/** Renders one resource definition with its originating file for the source jump. */
export function renderResourceDefinition(document: ResourceDefinitionDocument, options: ResourcePanelOptions = {}): string {
  const prefix = options.commandPrefix ?? "dext";
  const { entry } = document;
  const apiDetails = apiEntries(entry).map(item => {
    const api = entry.kind === "api" ? item.api : undefined;
    const highlightedApiSignature = renderApiSignature(item);
    const resultTitle = api ? ` title="${escapeResourceHtml(`Returned by ${api.signature}`)}"` : "";
    return api
      ? `<section class="resource-api-docs">${item.description ? `<p class="resource-api-documentation">${escapeResourceHtml(item.description)}</p>` : ""}<p class="resource-api-signature"><code>${highlightedApiSignature}</code></p><h3>Parameters</h3><dl>${(api.parameters.length ? api.parameters : [{ name: "", type: "", required: true, description: "This API takes no parameters." }]).map((parameter) => parameter.name
        ? `<div><dt><code class="tok-propertyName">${escapeResourceHtml(parameter.name)}</code> <code class="resource-api-type">${highlightApiType(parameter.type)}</code>${parameter.required ? "" : " <em>(optional)</em>"}</dt><dd>${escapeResourceHtml(parameter.description ?? "No description provided.")}${parameter.defaultValue !== undefined ? ` <span class="resource-api-default">Default: <code>${highlightResourceSource(parameter.defaultValue)}</code></span>` : ""}</dd></div>`
        : `<p>${escapeResourceHtml(parameter.description ?? "")}</p>`).join("")}</dl><h3>Returns</h3><p><code class="resource-result-type"${resultTitle}>${highlightApiType(api.returnType)}</code></p></section>`
      : "";
  }).join("");
  const referenceDetails = entry.reference ? renderReferenceModule(entry.reference) : "";
  // A flow without source (a built-in or a reference entry) has no module to analyse.
  const flow = entry.apiFlow ? renderApiFlow(entry.apiFlow, entry.name) : "";
  // A reference entry is documentation rather than a file: it has no Dext call to
  // insert and no source to open, and its own section is the whole page.
  const actions = entry.reference ? `<span class="resource-source">TypeScript declaration</span>`
    : (entry.source.path ? `<button type="button" data-resource-command="${prefix}.openResourceSource" data-resource-path="${escapeResourceHtml(entry.source.path)}">Open source</button>` : "")
      + `<button type="button" data-resource-command="${prefix}.insertResourceReference" data-resource-id="${escapeResourceHtml(entry.id)}">Insert reference</button>`;
  const source = entry.reference || !document.content ? ""
    : `<h3 class="resource-source-heading">Source</h3><pre class="resource-content" data-resource-source="${escapeResourceHtml(document.content)}"><code>${entry.kind === "api" ? highlightResourceSource(document.content) : escapeResourceHtml(document.content)}</code></pre>`;
  return `<div class="resource-definition" data-resource-id="${escapeResourceHtml(entry.id)}">`
    + renderResourceNavigation(options)
    + `<header class="resource-toolbar"><h2>${escapeResourceHtml(entry.name)}</h2>`
    + actions
    + `</header>${apiDetails}${flow}${referenceDetails}${source}</div>${resourceClientScript(options.tabState)}`;
}