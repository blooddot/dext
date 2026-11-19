import type { DextHistoryRecord, DextHistorySummary } from "../../conversations/contracts/history.js";
import type { SyncPreferences } from "../contracts/sync.js";

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Conversation bodies are append-only, but a turn may also be deleted, so a
 * plain union is wrong in both directions. The rule: when the newer side only
 * lost turns, the deletion won; otherwise both sides' turns are kept. A turn id
 * is globally unique, which makes the merge commutative for the common case of
 * two machines appending to the same conversation while apart. */
export function mergeTurns(
  local: readonly DextHistoryRecord[],
  remote: readonly DextHistoryRecord[],
  localIsNewer: boolean
): DextHistoryRecord[] {
  const newer = localIsNewer ? local : remote;
  const older = localIsNewer ? remote : local;
  const newerIds = new Set(newer.map((turn) => turn.id));
  const olderIds = new Set(older.map((turn) => turn.id));
  const removed = [...olderIds].filter((id) => !newerIds.has(id));
  const added = [...newerIds].filter((id) => !olderIds.has(id));
  // The newer side both removed and added: that is an edit conflict, and losing
  // a stored turn is worse than keeping one the user deleted.
  if (removed.length && !added.length) return [...newer];
  const byId = new Map<string, DextHistoryRecord>();
  // The local copy wins for a shared turn: its spill path points at a file this
  // machine can open.
  for (const turn of local) byId.set(turn.id, turn);
  for (const turn of remote) if (!byId.has(turn.id)) byId.set(turn.id, turn);
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/** Metadata follows the later write, while provider bindings and spill paths
 * accumulate because each side may have learned different ones. Fields the
 * newer side dropped (archive, active plan) stay dropped: absence is how those
 * are cleared. */
export function mergeSummary(
  local: DextHistorySummary,
  remote: DextHistorySummary,
  turns: readonly DextHistoryRecord[]
): DextHistorySummary {
  const newer = local.updatedAt >= remote.updatedAt ? local : remote;
  const older = newer === local ? remote : local;
  const providerSessions = { ...(older.providerSessions ?? {}), ...(newer.providerSessions ?? {}) };
  const spills = { ...(older.spills ?? {}), ...(newer.spills ?? {}) };
  const merged: DextHistorySummary = {
    ...newer,
    id: newer.id,
    createdAt: Math.min(local.createdAt, remote.createdAt),
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    turnCount: turns.length
  };
  delete merged.firstInput;
  if (turns[0]) merged.firstInput = turns[0].input;
  if (Object.keys(providerSessions).length) merged.providerSessions = providerSessions;
  if (Object.keys(spills).length) merged.spills = spills;
  return merged;
}

/** Preferences have no per-key timestamps, so the local value wins for a key
 * both machines know and the remote value fills the rest. Pins, favourites and
 * open tabs are additive. */
export function mergePreferences(local: SyncPreferences, remote: SyncPreferences): SyncPreferences {
  const active = local.layout.activeConversationId ?? remote.layout.activeConversationId;
  return {
    pinned: unique([...local.pinned, ...remote.pinned]),
    favorites: unique([...local.favorites, ...remote.favorites]),
    titles: { ...remote.titles, ...local.titles },
    layout: {
      openConversationIds: unique([...local.layout.openConversationIds, ...remote.layout.openConversationIds]),
      ...(active ? { activeConversationId: active } : {})
    },
    selections: { ...remote.selections, ...local.selections },
    drafts: { ...remote.drafts, ...local.drafts }
  };
}

export function samePreferences(left: SyncPreferences, right: SyncPreferences): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
