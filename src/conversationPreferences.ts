import type * as vscode from "vscode";
import type { AgentSelection } from "./agentProfiles.js";

const PINNED_KEY = "dext.pinnedConversations";
const FAVORITES_KEY = "dext.favoriteConversations";
const TITLES_KEY = "dext.conversationTitles";
const LAYOUT_KEY = "dext.conversationLayout";
const MAX_TITLE_LENGTH = 140;
const SORT_ORDER_KEY = "dext.historySortOrder";
const FAVORITES_ONLY_KEY = "dext.historyFavoritesOnly";
const ARCHIVED_ONLY_KEY = "dext.historyArchivedOnly";
const SELECTIONS_KEY = "dext.conversationSelections";

export type HistorySortOrder = "newest" | "oldest";

export interface HistoryOrdering {
  order: HistorySortOrder;
  favorites: readonly string[];
  favoritesOnly: boolean;
  archivedOnly?: boolean;
}

export interface ConversationLayout {
  /** Conversation tabs that should be restored when VS Code starts again. */
  openConversationIds: readonly string[];
  /** The tab that was selected when the extension host last stopped. */
  activeConversationId?: string;
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

  conversationLayout(): ConversationLayout {
    const stored = this.state.get<Partial<ConversationLayout>>(LAYOUT_KEY, {});
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

  async setConversationLayout(layout: ConversationLayout): Promise<void> {
    const openConversationIds = [...new Set(layout.openConversationIds.filter(Boolean))];
    await this.state.update(LAYOUT_KEY, {
      openConversationIds,
      ...(layout.activeConversationId ? { activeConversationId: layout.activeConversationId } : {})
    } satisfies ConversationLayout);
  }

  /** Composer settings that belong to an individual conversation tab. */
  conversationSelection(sessionId: string): AgentSelection | undefined {
    const selections = this.state.get<Record<string, AgentSelection>>(SELECTIONS_KEY, {});
    const selection = selections[sessionId];
    return selection && typeof selection === "object" ? { ...selection } : undefined;
  }

  async setConversationSelection(sessionId: string, selection: AgentSelection): Promise<void> {
    const selections = { ...this.state.get<Record<string, AgentSelection>>(SELECTIONS_KEY, {}) };
    selections[sessionId] = { ...selection };
    await this.state.update(SELECTIONS_KEY, selections);
  }

  async forgetConversationSelection(sessionId: string): Promise<void> {
    const selections = { ...this.state.get<Record<string, AgentSelection>>(SELECTIONS_KEY, {}) };
    if (!(sessionId in selections)) return;
    delete selections[sessionId];
    await this.state.update(SELECTIONS_KEY, selections);
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

  archivedOnly(): boolean {
    return this.state.get<boolean>(ARCHIVED_ONLY_KEY, false);
  }

  async setArchivedOnly(archivedOnly: boolean): Promise<void> {
    await this.state.update(ARCHIVED_ONLY_KEY, archivedOnly);
  }

  async setFavoritesOnly(favoritesOnly: boolean): Promise<void> {
    await this.state.update(FAVORITES_ONLY_KEY, favoritesOnly);
  }

  historyOrdering(): HistoryOrdering {
    return {
      order: this.sortOrder(),
      favorites: this.favorites(),
      favoritesOnly: this.favoritesOnly(),
      archivedOnly: this.archivedOnly()
    };
  }

  // A deleted conversation must not linger as a pin that reopens on reload, a
  // favourite that never resolves, or a name with nothing behind it.
  async forget(sessionId: string): Promise<void> {
    await this.setPinned(sessionId, false);
    await this.setFavorite(sessionId, false);
    await this.setTitle(sessionId, "");
    await this.forgetConversationSelection(sessionId);
    const layout = this.conversationLayout();
    await this.setConversationLayout({
      openConversationIds: layout.openConversationIds.filter((id) => id !== sessionId),
      ...(layout.activeConversationId === sessionId ? {} : { activeConversationId: layout.activeConversationId })
    });
  }
}
