/** The three appearance states every Dext surface shares. `auto` follows the
 * workbench theme, including its high-contrast variants; `paper` and `dim` are
 * self-contained palettes so a reading surface never depends on the editor theme. */
export const DEXT_APPEARANCES = ["auto", "paper", "dim"] as const;

export type DextAppearance = (typeof DEXT_APPEARANCES)[number];

/** Memento key: host-persisted, so separate webviews cannot disagree. */
export const DEXT_APPEARANCE_KEY = "dext.appearance";

export function isDextAppearance(value: unknown): value is DextAppearance {
  return value === "auto" || value === "paper" || value === "dim";
}
