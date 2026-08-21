import type * as vscode from "vscode";

const PINNED_KEY = "dext.pinnedConversations";
const FAVORITES_KEY = "dext.favoriteConversations";
const TITLES_KEY = "dext.conversationTitles";
const MAX_TITLE_LENGTH = 140;
const SORT_ORDER_KEY = "dext.historySortOrder";
const FAVORITES_ONLY_KEY = "dext.historyFavoritesOnly";

export type HistorySortOrder = "newest" | "oldest";

export interface HistoryOrdering {
  order: HistorySortOrder;
  favorites: readonly string[];
  favoritesOnly: boolean;
}

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
  const visible = ordering.favoritesOnly
    ? sessions.filter((session) => favorites.has(session.id))
    : [...sessions];
  const direction = ordering.order === "newest" ? -1 : 1;
  return visible.sort((left, right) => {
    const byFavorite = Number(favorites.has(right.id)) - Number(favorites.has(left.id));
    return byFavorite || direction * (lastActivity(left) - lastActivity(right));
  });
}

/** Pinning keeps a conversation open across reloads, favouriting keeps it at
 * the top of history, and renaming replaces the name taken from its first
 * message. All three are keyed by conversation id, which is also the id the
 * agent runners bind their CLI or AIOA session to, so none of them can detach
 * a conversation from the agent that is answering it. */
export class DextConversationPreferences {
  constructor(private readonly state: vscode.Memento) {}

  pinned(): string[] {
    return this.state.get<string[]>(PINNED_KEY, []);
  }

  isPinned(sessionId: string): boolean {
    return this.pinned().includes(sessionId);
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    const remaining = this.pinned().filter((id) => id !== sessionId);
    await this.state.update(PINNED_KEY, pinned ? [...remaining, sessionId] : remaining);
  }

  favorites(): string[] {
    return this.state.get<string[]>(FAVORITES_KEY, []);
  }

  isFavorite(sessionId: string): boolean {
    return this.favorites().includes(sessionId);
  }

  async setFavorite(sessionId: string, favorite: boolean): Promise<void> {
    const remaining = this.favorites().filter((id) => id !== sessionId);
    await this.state.update(FAVORITES_KEY, favorite ? [...remaining, sessionId] : remaining);
  }

  title(sessionId: string): string | undefined {
    return this.state.get<Record<string, string>>(TITLES_KEY, {})[sessionId];
  }

  // An empty name is how the user asks for the first message to name the
  // conversation again.
  async setTitle(sessionId: string, title: string): Promise<void> {
    const titles = { ...this.state.get<Record<string, string>>(TITLES_KEY, {}) };
    const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH);
    if (trimmed) titles[sessionId] = trimmed;
    else delete titles[sessionId];
    await this.state.update(TITLES_KEY, titles);
  }

  sortOrder(): HistorySortOrder {
    return this.state.get<HistorySortOrder>(SORT_ORDER_KEY, "newest") === "oldest" ? "oldest" : "newest";
  }

  async setSortOrder(order: HistorySortOrder): Promise<void> {
    await this.state.update(SORT_ORDER_KEY, order);
  }

  favoritesOnly(): boolean {
    return this.state.get<boolean>(FAVORITES_ONLY_KEY, false);
  }

  async setFavoritesOnly(favoritesOnly: boolean): Promise<void> {
    await this.state.update(FAVORITES_ONLY_KEY, favoritesOnly);
  }

  historyOrdering(): HistoryOrdering {
    return {
      order: this.sortOrder(),
      favorites: this.favorites(),
      favoritesOnly: this.favoritesOnly()
    };
  }

  // A deleted conversation must not linger as a pin that reopens on reload, a
  // favourite that never resolves, or a name with nothing behind it.
  async forget(sessionId: string): Promise<void> {
    await this.setPinned(sessionId, false);
    await this.setFavorite(sessionId, false);
    await this.setTitle(sessionId, "");
  }
}
