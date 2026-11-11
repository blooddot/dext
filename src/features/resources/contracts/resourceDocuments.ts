import type { ApiFlow } from "../../workflow/contracts/apiFlow.js";
import type { ApiReferenceCatalog, ApiReferenceModule, ApiSourceFunction } from "../../workflow/contracts/apiReference.js";
import type { RegisteredCallable } from "../../../shared/contracts/types.js";
import { isSkillId } from "../../workflow/contracts/skill.js";
import { type EditorTabManager } from "../../../platform/editor-tabs/editorTabManager.js";
import type { EditorTabRestorer } from "../../../platform/editor-tabs/editorTabSerializer.js";
import type { EditorTabState } from "../../../platform/editor-tabs/editorTabState.js";
import { type ResourceKind, type ResourcePage, type ResourceScope } from "./resourceSession.js";


export interface ResourceSourceRef {
  kind: "project" | "global" | "directory";
  path?: string;
}


export interface ResourcePackRef {
  id: string;
  name: string;
  upstreamVersion?: string;
  releaseTag?: string;
  commit?: string;
  /** An installed import with a GitHub source, so it can be updated. */
  updatable: boolean;
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
  /** Present when a pack manifest owns this canonical Skill. */
  pack?: ResourcePackRef;
  /** A Skill the composer's Input menu leaves out; it still loads by id. */
  hidden?: boolean;
  api?: ApiSourceFunction["api"];
  /** Exported functions read from a file; both pages render these with the same API component. */
  apiFunctions?: ApiSourceFunction[];
  /** Function-level Execution flow. Parsed only for a detail page, never for a list. */
  apiFlow?: ApiFlow;
  /** A read-only reference entry: a Node module or JavaScript global documented
   * from its own declaration rather than a callable Dext API. */
  reference?: ApiReferenceModule;
}


/** The Skill id a canonical `<id>/SKILL.md` entry owns. Other files below a
 * Skill directory are not the Skill itself. */
export function skillEntryId(entry: Pick<ResourceEntry, "kind" | "path">): string | undefined {
  if (entry.kind !== "skill") return undefined;
  const match = /^([^/]+)\/SKILL\.md$/.exec(entry.path);
  return match && isSkillId(match[1]) ? match[1] : undefined;
}


export interface ResourceListDocument {
  kind: ResourceKind;
  scope: ResourcePage;
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
  scope?: ResourcePage;
  availableScopes?: readonly ResourcePage[];
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
  /** The built-in Dext APIs its own page lists; every other page reads the file scopes. */
  builtinDataSource?: ResourceEditorDataSource;
  scope: ResourcePage;
  /** Main workspace root, used to keep tabs distinct across roots. */
  scopeKey?: string;
  availableScopes?(): readonly ResourcePage[];
  commandPrefix?: string;
  /** Runs a toolbar command. Return true after removing a resource to refresh its list. */
  onCommand?(command: string, payload: { id?: string; kind?: string; path?: string; pack?: string; query?: string; scope?: ResourcePage }): Promise<void | boolean> | void | boolean;
  /** Copies text the page offers, such as a module specifier; the host owns the clipboard. */
  copyText?(text: string): Promise<void> | void;
}


export interface ResourceEditorShowResult {
  key: string;
  created: boolean;
}


export interface FileResourceDataSourceOptions {
  roots(): Partial<Record<ResourceScope, string>>;
  /** Enumerates files without importing or executing TypeScript API modules. */
  listFiles(kind: Exclude<ResourceKind, "file">): Promise<Array<{ name: string; path: string; scope: ResourceScope; pack?: ResourcePackRef; hidden?: boolean }>>;
  readFile(entry: ResourceEntry): Promise<string | undefined>;
  describeApi?(content: string): Promise<ApiSourceFunction[]>;
  /** Builds the flow for a detail page; lists deliberately skip it. The second
   * argument is the API's leaf name, which is the entry function's name. */
  describeApiFlow?(content: string, entryName?: string): Promise<ApiFlow>;
}


export type ApiCallable = Pick<RegisteredCallable, "id" | "title" | "description" | "kind" | "source" | "input" | "output">;


export interface ApiDataSourceOptions {
  methods(): readonly ApiCallable[];
  reference?(): Promise<ApiReferenceCatalog | undefined>;
}
