import type { ApiFlow } from "../../workflow/contracts/apiFlow.js";
import type { ApiReferenceCatalog, ApiReferenceModule, ApiSourceFunction } from "../../workflow/contracts/apiReference.js";
import type { RegisteredCallable } from "../../../shared/contracts/types.js";
import { type EditorTabManager } from "../../../platform/editor-tabs/editorTabManager.js";
import type { EditorTabRestorer } from "../../../platform/editor-tabs/editorTabSerializer.js";
import type { EditorTabState } from "../../../platform/editor-tabs/editorTabState.js";
import { type ResourceKind, type ResourceScope } from "./resourceSession.js";


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
  /** The short name a nested tree shows; defaults to the last dotted segment. */
  displayName?: string;
  /** Relative path inside the resource directory. */
  path: string;
  source: ResourceSourceRef;
  group: string;
  description?: string;
  api?: ApiSourceFunction["api"];
  /** Exported functions read from a file; both pages render these with the same API component. */
  apiFunctions?: ApiSourceFunction[];
  /** Function-level Execution flow. Parsed only for a detail page, never for a list. */
  apiFlow?: ApiFlow;
  /** A read-only reference entry: a Node module or JavaScript global documented
   * from its own declaration rather than a callable Dext API. */
  reference?: ApiReferenceModule;
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


export interface ResourcePanelOptions {
  /** Base command prefix used for source jumps and the existing edit flows. */
  commandPrefix?: string;
  title?: string;
  createKinds?: readonly ResourceKind[];
  /** Offers a toolbar button that opens the current scope's resource directory. */
  openResourceDirectory?: boolean;
  scope?: ResourceScope;
  availableScopes?: readonly ResourceScope[];
  collapsed?: readonly string[];
  /** The API directory nests its dotted namespaces under a synthetic Top level group. */
  apiTree?: boolean;
  /** The Resources page nests each category's namespaces instead of listing it flat. */
  categoryTree?: boolean;
  navigation?: { canGoBack: boolean; canGoForward: boolean; label?: string; scrollTop: number };
  /** Tab state persisted through `setState`, so a reload restores this exact page. */
  tabState?: EditorTabState;
}


export interface ResourceTreeNode { label: string; path: string; entries: ResourceEntry[]; children: Map<string, ResourceTreeNode>; }


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
  /** Runs a toolbar command. Return true after removing a resource to refresh its list. */
  onCommand?(command: string, payload: { id?: string; kind?: string; path?: string; query?: string; scope?: ResourceScope }): Promise<void | boolean> | void | boolean;
  /** Copies text the page offers, such as a module specifier; the host owns the clipboard. */
  copyText?(text: string): Promise<void> | void;
  /** Page renderers. The migrated API and Global Resources pages override these. */
  renderList?: (document: ResourceListDocument, options: ResourcePanelOptions) => string;
  renderDetail?: (document: ResourceDefinitionDocument, options: ResourcePanelOptions) => string;
}


export interface ResourceEditorShowResult {
  key: string;
  created: boolean;
}


export interface FileResourceDataSourceOptions {
  roots(): Partial<Record<ResourceScope, string>>;
  /** Enumerates files without importing or executing TypeScript API modules. */
  listFiles(kind: Exclude<ResourceKind, "file">): Promise<Array<{ name: string; path: string; scope: ResourceScope }>>;
  readFile(entry: ResourceEntry): Promise<string | undefined>;
  describeApi?(content: string): Promise<ApiSourceFunction[]>;
  /** Builds the function call graph for a detail page; lists deliberately skip it. */
  describeApiFlow?(content: string): Promise<ApiFlow>;
}


export type ApiCallable = Pick<RegisteredCallable, "id" | "title" | "description" | "kind" | "source" | "input" | "output">;


export interface ApiDataSourceOptions {
  methods(): readonly ApiCallable[];
  files?: ResourceEditorDataSource;
  reference?(): Promise<ApiReferenceCatalog | undefined>;
}
