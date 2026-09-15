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

export function createEditorTabState(key: string, options: { page?: string; filters?: Record<string, string> } = {}): EditorTabState | undefined {
  const parsed = parseEditorTabKey(key);
  if (!parsed) return undefined;
  return {
    key,
    page: normalizePage(parsed.kind, options.page),
    ...(parsed.resourceId ? { resourceId: parsed.resourceId } : {}),
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
  return { state: { ...result.data, page: normalizePage(parsed.kind, result.data.page) } };
}
