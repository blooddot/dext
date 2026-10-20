import { z } from "zod";
import { EDITOR_TAB_PAGES, EDITOR_TAB_RESTORE_VERSION, parseEditorTabKey, type EditorTabKind } from "./editorTabTypes.js";

export const editorTabStateSchema = z.object({
  key: z.string().min(1),
  page: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  filters: z.record(z.string(), z.string()).default({}),
  restoreVersion: z.number().int().positive().default(EDITOR_TAB_RESTORE_VERSION)
}).strict();
export type EditorTabState = z.infer<typeof editorTabStateSchema>;

export function defaultPageFor(kind: EditorTabKind): string {
  return EDITOR_TAB_PAGES[kind][0]!;
}

/** A page that does not belong to the tab kind falls back to that kind's first page. */
export function normalizePage(kind: EditorTabKind, page: string | undefined): string {
  if (page && EDITOR_TAB_PAGES[kind].includes(page)) return page;
  return defaultPageFor(kind);
}

export function createEditorTabState(key: string, options: { page?: string; resourceId?: string; filters?: Record<string, string> } = {}): EditorTabState | undefined {
  const parsed = parseEditorTabKey(key);
  if (!parsed) return undefined;
  // One tab can show several targets (an API browser lists and opens definitions), so the caller may
  // record which target is on screen even when the key itself carries no resource id.
  const resourceId = options.resourceId ?? parsed.resourceId;
  return {
    key,
    page: normalizePage(parsed.kind, options.page),
    ...(resourceId ? { resourceId } : {}),
    filters: options.filters ?? {},
    restoreVersion: EDITOR_TAB_RESTORE_VERSION
  };
}

/**
 * Validates a restored tab state. A missing resource is reported as recoverable rather than
 * silently opening an unrelated page, and an unknown key is rejected outright.
 */
export function restoreEditorTabState(input: unknown): { state?: EditorTabState; error?: string } {
  const parsed = parseEditorTabKey(typeof (input as { key?: unknown })?.key === "string" ? (input as { key: string }).key : "");
  if (!parsed) return { error: "Unknown editor tab key." };
  const result = editorTabStateSchema.safeParse(input);
  if (!result.success) return { error: "Invalid editor tab state." };
  // A state written by a newer build may describe pages this build does not have, so it is skipped
  // rather than normalized into today's vocabulary. Older states keep their documented defaults.
  if (result.data.restoreVersion > EDITOR_TAB_RESTORE_VERSION) {
    return { error: `Editor tab state version ${result.data.restoreVersion} is newer than this build supports.` };
  }
  return { state: { ...result.data, page: normalizePage(parsed.kind, result.data.page) } };
}
