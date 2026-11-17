import type { PlanAcceptanceItem } from "../../../shared/contracts/types.js";

/** Identity comes from the requirement's wording, not from its position: a
 * reordered or inserted item must never inherit another item's checkmark. */
function acceptanceKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** FNV-1a over the normalised text: stable across sessions and machines without
 * adding a dependency or a stored counter. */
function acceptanceHash(text: string): string {
  let hash = 0x811c9dc5;
  for (const char of acceptanceKey(text)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Two items with identical wording still need separate IDs, so repeated text
 * gets a `-2`, `-3` suffix by order of appearance. */
export function planAcceptanceId(text: string, occurrence = 1): string {
  const base = `accept-${acceptanceHash(text)}`;
  return occurrence > 1 ? `${base}-${occurrence}` : base;
}

/** Give a freshly parsed list its IDs, numbering repeated wording by order. */
export function identifyPlanAcceptance(entries: readonly { text: string; checked: boolean }[]): PlanAcceptanceItem[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const key = acceptanceKey(entry.text);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { id: planAcceptanceId(entry.text, occurrence), text: entry.text, checked: entry.checked };
  });
}

/** Apply the stored checkmarks to a changed list by ID. An item whose wording
 * changed has a new ID on purpose, so its old check does not follow it. */
export function mergePlanAcceptance(
  current: readonly PlanAcceptanceItem[],
  previous: readonly PlanAcceptanceItem[]
): PlanAcceptanceItem[] {
  const saved = new Map(previous.map((item) => [item.id, item.checked]));
  return current.map((item) => ({ ...item, checked: saved.get(item.id) ?? item.checked }));
}

/** One user click flips one item; every other item keeps its state. */
export function togglePlanAcceptance(
  items: readonly PlanAcceptanceItem[],
  id: string,
  checked: boolean
): PlanAcceptanceItem[] {
  return items.map((item) => (item.id === id ? { ...item, checked } : { ...item }));
}

/** The acceptance group has its own count, so the development task counts stay
 * untouched by user-owned items. */
export function planAcceptanceProgress(items: readonly PlanAcceptanceItem[]): {
  total: number;
  checked: number;
  complete: boolean;
  remaining: number;
} {
  const checked = items.filter((item) => item.checked).length;
  return { total: items.length, checked, complete: items.length > 0 && checked === items.length, remaining: items.length - checked };
}
