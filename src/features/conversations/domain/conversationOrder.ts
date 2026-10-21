import type { ConversationLayout, HistoryOrdering } from "../contracts/preferences.js";

/** Ordering, pinning and layout normalization for conversations. Pure data:
 * the host store, the History page and the sidebar all use the same rules. */

interface OrderableSession {
  id: string;
  createdAt: number;
  updatedAt: number;
}

// A conversation with no turns yet still reports its creation time, so the
// later of the two timestamps is the moment the user last touched it.
function lastActivity(session: OrderableSession): number {
  return Math.max(session.updatedAt, session.createdAt);
}

export function orderHistorySessions<T extends OrderableSession>(
  sessions: readonly T[],
  ordering: HistoryOrdering
): T[] {
  const favorites = new Set(ordering.favorites);
  const visible = sessions.filter((session) => {
    const archived = Boolean((session as T & { archivedAt?: number }).archivedAt);
    return archived === Boolean(ordering.archivedOnly) && (!ordering.favoritesOnly || favorites.has(session.id));
  });
  const direction = ordering.order === "newest" ? -1 : 1;
  return visible.sort((left, right) => {
    const byFavorite = Number(favorites.has(right.id)) - Number(favorites.has(left.id));
    return byFavorite || direction * (lastActivity(left) - lastActivity(right));
  });
}

/** Pinned tabs lead the strip so that they keep their place as other
 * conversations open and close beside them. */
export function orderedConversationIds(openIds: readonly string[], isPinned: (sessionId: string) => boolean): string[] {
  const pinned = openIds.filter((id) => isPinned(id));
  return [...pinned, ...openIds.filter((id) => !pinned.includes(id))];
}

/** Stored layouts may predate tabs, carry duplicates or name conversations that
 * no longer exist; one parser keeps every reader honest. */
export function normalizeConversationLayout(stored: Partial<ConversationLayout>): ConversationLayout {
  const openConversationIds = Array.isArray(stored.openConversationIds)
    ? [...new Set(stored.openConversationIds.filter((id): id is string => typeof id === "string" && Boolean(id)))]
    : [];
  return {
    openConversationIds,
    ...(typeof stored.activeConversationId === "string" && stored.activeConversationId
      ? { activeConversationId: stored.activeConversationId }
      : {})
  };
}
