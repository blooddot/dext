import { EDITOR_TAB_TITLES, EDITOR_TAB_VIEW_TYPES, parseEditorTabKey, type EditorTabKind } from "./editorTabTypes.js";
import { restoreEditorTabState, type EditorTabState } from "./editorTabState.js";
import type { EditorTabDescriptorLike, EditorTabManager, EditorTabPanelHandle } from "./editorTabManager.js";

export type RestoreOrigin = "serializer" | "proactive";

export interface EditorTabRestoreResult {
  status: "opened" | "reused" | "skipped" | "invalid";
  key?: string;
  error?: string;
}

export interface EditorTabRestoreOptions {
  descriptor?: EditorTabDescriptorLike;
  html?: string;
}

export function descriptorForKey(key: string, resourceLabel?: string): EditorTabDescriptorLike | undefined {
  const parsed = parseEditorTabKey(key);
  if (!parsed) return undefined;
  return {
    key,
    kind: parsed.kind,
    viewType: EDITOR_TAB_VIEW_TYPES[parsed.kind],
    title: resourceLabel ? `${EDITOR_TAB_TITLES[parsed.kind]}: ${resourceLabel}` : EDITOR_TAB_TITLES[parsed.kind],
    ...(resourceLabel ? { resourceLabel } : {})
  };
}

/**
 * Bridges VS Code panel restoration and the extension's own proactive restore into the unified
 * manager. A key that is already open, or currently being restored by the other path, is reused
 * or skipped so a page is never created twice.
 */
export class EditorTabRestorer {
  private readonly pending = new Set<string>();

  constructor(private readonly manager: EditorTabManager) {}

  private busy(key: string): boolean {
    return this.pending.has(key);
  }

  restore(stateInput: unknown, _origin: RestoreOrigin, options: EditorTabRestoreOptions = {}): EditorTabRestoreResult {
    const { state, error } = restoreEditorTabState(stateInput);
    if (!state || error) return { status: "invalid", error: error ?? "Invalid editor tab state." };
    const key = state.key;
    if (this.manager.has(key)) {
      this.manager.reveal(key);
      return { status: "reused", key };
    }
    if (this.busy(key)) return { status: "skipped", key };
    this.pending.add(key);
    try {
      const descriptor = options.descriptor ?? descriptorForKey(key, state.resourceId ? state.resourceId.split("/").at(-1) : undefined);
      if (!descriptor) return { status: "invalid", key, error: "Unknown editor tab key." };
      const result = this.manager.open(descriptor);
      if (result.created && options.html && result.panel.setHtml) result.panel.setHtml(options.html);
      return { status: result.created ? "opened" : "reused", key };
    } finally {
      this.pending.delete(key);
    }
  }

  /** Called by the serializer before handing a panel over, preventing a concurrent second open. */
  claim(key: string): boolean {
    if (this.manager.has(key) || this.busy(key)) return false;
    this.pending.add(key);
    return true;
  }

  /**
   * Adopts a panel VS Code already restored. If the proactive path opened the same key first, the
   * restored panel is disposed by the manager, so a serializer restore never double-opens a tab.
   */
  adoptRestored(
    stateInput: unknown,
    create: (key: string, descriptor: EditorTabDescriptorLike) => EditorTabPanelHandle | undefined,
    html?: string
  ): EditorTabRestoreResult {
    const { state, error } = restoreEditorTabState(stateInput);
    if (!state || error) return { status: "invalid", error: error ?? "Invalid editor tab state." };
    const key = state.key;
    if (this.busy(key)) return { status: "skipped", key };
    const descriptor = descriptorForKey(key, state.resourceId ? state.resourceId.split("/").at(-1) : undefined);
    if (!descriptor) return { status: "invalid", key, error: "Unknown editor tab key." };
    this.pending.add(key);
    try {
      const handle = create(key, descriptor);
      if (!handle) return { status: "invalid", key, error: "Editor tab panel is unavailable." };
      const result = this.manager.adopt(key, descriptor, handle);
      if (result.created && html && result.panel.setHtml) result.panel.setHtml(html);
      return { status: result.created ? "opened" : "reused", key };
    } finally {
      this.pending.delete(key);
    }
  }

  release(key: string): void {
    this.pending.delete(key);
  }
}

export function editorTabKindOf(key: string): EditorTabKind | undefined {
  return parseEditorTabKey(key)?.kind;
}

export type { EditorTabState };
