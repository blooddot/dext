/** The appearance states every Dext surface shares. The view-title action toggles
 * `light` and `dark`, two self-contained palettes keyed to VS Code's default
 * themes; `auto` is only the starting point and the high-contrast fallback, and
 * follows the workbench theme. */
export const DEXT_APPEARANCES = ["auto", "light", "dark"] as const;

export type DextAppearance = (typeof DEXT_APPEARANCES)[number];

/** Memento key: host-persisted, so separate webviews cannot disagree. */
export const DEXT_APPEARANCE_KEY = "dext.appearance";

export function isDextAppearance(value: unknown): value is DextAppearance {
  return value === "auto" || value === "light" || value === "dark";
}
