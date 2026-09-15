/**
 * Editor-panel identity shared by Project, API, Global Resources, and History.
 *
 * A stable key is derived from the page kind plus an optional resource id, never from a document
 * title or an array index, so the same target resolves to the same tab across reloads.
 */
export type EditorTabKind = "project" | "api" | "globalResources" | "history";

export const EDITOR_TAB_VIEW_TYPES: Record<EditorTabKind, string> = {
  project: "dext.project",
  api: "dext.api",
  globalResources: "dext.globalResources",
  history: "dext.history"
};

export const EDITOR_TAB_TITLES: Record<EditorTabKind, string> = {
  project: "Dext Project",
  api: "Dext APIs",
  globalResources: "Dext Resources",
  history: "Dext History"
};

/** Page choices each kind exposes. Project deliberately has no Hooks, Review, or task log page. */
export const EDITOR_TAB_PAGES: Record<EditorTabKind, readonly string[]> = {
  project: ["overview", "knowledge", "architecture"],
  api: ["list", "detail"],
  globalResources: ["list", "detail"],
  history: ["list"]
};

export const EDITOR_TAB_RESTORE_VERSION = 1;

export interface EditorTabKey {
  kind: EditorTabKind;
  /** Stable resource identity (for example an API id or a project object id). */
  resourceId?: string;
  /** Main workspace root. The first version keeps one root. */
  scope?: string;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/** Builds a stable, parseable key. Resource ids survive renames because they are ids, not names. */
export function editorTabKey(kind: EditorTabKind, options: { resourceId?: string; scope?: string } = {}): string {
  const parts = [`dext.editor:${kind}`];
  if (options.scope) parts.push(`@${encodeSegment(options.scope)}`);
  if (options.resourceId) parts.push(`#${encodeSegment(options.resourceId)}`);
  return parts.join("");
}

export function parseEditorTabKey(key: string): EditorTabKey | undefined {
  const match = /^dext\.editor:([a-zA-Z]+)(?:@([^#]+))?(?:#(.+))?$/.exec(key);
  if (!match) return undefined;
  const kind = match[1] as EditorTabKind;
  if (!(kind in EDITOR_TAB_VIEW_TYPES)) return undefined;
  const scope = match[2] ? decodeURIComponent(match[2]) : undefined;
  const resourceId = match[3] ? decodeURIComponent(match[3]) : undefined;
  return { kind, ...(scope ? { scope } : {}), ...(resourceId ? { resourceId } : {}) };
}

export function isEditorTabKind(value: string): value is EditorTabKind {
  return value in EDITOR_TAB_VIEW_TYPES;
}

export function isRecoverableEditorTabKey(key: string): boolean {
  return parseEditorTabKey(key) !== undefined;
}

export function editorTabTitle(kind: EditorTabKind, resourceLabel?: string): string {
  return resourceLabel ? `${EDITOR_TAB_TITLES[kind]}: ${resourceLabel}` : EDITOR_TAB_TITLES[kind];
}
