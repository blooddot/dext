import type * as vscode from "vscode";
import type { AgentSelection } from "../../agents/contracts/agent.js";
import type {
  ComposerDraft,
  ConversationLayout,
  ConversationPreferences,
  HistoryOrdering
} from "../contracts/preferences.js";
import { normalizeConversationLayout } from "../domain/conversationOrder.js";
import { normalizeAgentSelection } from "../domain/agentSelection.js";

const PINNED_KEY = "dext.pinnedConversations";
const FAVORITES_KEY = "dext.favoriteConversations";
const TITLES_KEY = "dext.conversationTitles";
const LAYOUT_KEY = "dext.conversationLayout";
const MAX_TITLE_LENGTH = 140;
const FAVORITES_ONLY_KEY = "dext.historyFavoritesOnly";
const ARCHIVED_ONLY_KEY = "dext.historyArchivedOnly";
const SELECTIONS_KEY = "dext.conversationSelections";
const DRAFTS_KEY = "dext.composerDrafts";

/** Pinning keeps a conversation open across reloads, favouriting keeps it at
 * the top of history, and renaming replaces the name taken from its first
 * message. All three are keyed by conversation id, which is also the id the
 * agent runners bind their provider session to, so none of them can detach
 * a conversation from the agent that is answering it. */
export class DextConversationPreferences implements ConversationPreferences {
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
    return normalizeConversationLayout(this.state.get<Partial<ConversationLayout>>(LAYOUT_KEY, {}));
  }

  async setConversationLayout(layout: ConversationLayout): Promise<void> {
    await this.state.update(LAYOUT_KEY, normalizeConversationLayout(layout) satisfies ConversationLayout);
  }

  /** Composer settings that belong to an individual conversation tab. */
  conversationSelection(sessionId: string): AgentSelection | undefined {
    const selections = this.state.get<Record<string, AgentSelection>>(SELECTIONS_KEY, {});
    const selection = selections[sessionId];
    return selection && typeof selection === "object" ? normalizeAgentSelection({ ...selection }) : undefined;
  }

  async setConversationSelection(sessionId: string, selection: AgentSelection): Promise<void> {
    const selections = { ...this.state.get<Record<string, AgentSelection>>(SELECTIONS_KEY, {}) };
    selections[sessionId] = normalizeAgentSelection({ ...selection });
    await this.state.update(SELECTIONS_KEY, selections);
  }

  async forgetConversationSelection(sessionId: string): Promise<void> {
    const selections = { ...this.state.get<Record<string, AgentSelection>>(SELECTIONS_KEY, {}) };
    if (!(sessionId in selections)) return;
    delete selections[sessionId];
    await this.state.update(SELECTIONS_KEY, selections);
  }

  /** An unsent draft must survive a hidden, reloaded or restarted Webview, so it
   * is kept beside the other per-conversation choices instead of in the
   * document that typed it. */
  composerDrafts(): Record<string, ComposerDraft> {
    return this.state.get<Record<string, ComposerDraft>>(DRAFTS_KEY, {});
  }

  async setComposerDraft(sessionId: string, draft: ComposerDraft): Promise<void> {
    const drafts = { ...this.composerDrafts() };
    if (draft.source.trim() || draft.attachments.length) drafts[sessionId] = draft;
    else delete drafts[sessionId];
    await this.state.update(DRAFTS_KEY, drafts);
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
      favorites: this.favorites(),
      favoritesOnly: this.favoritesOnly(),
      archivedOnly: this.archivedOnly()
    };
  }

  /** Drop preferences whose conversation no longer exists. Trimming removes whole
   * conversations inside the history store's persist(), which has no preferences. */
  async pruneConversations(known: readonly string[]): Promise<void> {
    const ids = new Set(known);
    const kept = <T>(entries: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(entries).filter(([id]) => ids.has(id)));
    const selections = this.state.get<Record<string, AgentSelection>>(SELECTIONS_KEY, {});
    const titles = this.state.get<Record<string, string>>(TITLES_KEY, {});
    const drafts = this.composerDrafts();
    const pins = this.pinned(), favorites = this.favorites();
    const nextSelections = kept(selections), nextTitles = kept(titles), nextDrafts = kept(drafts);
    if (Object.keys(nextSelections).length !== Object.keys(selections).length) await this.state.update(SELECTIONS_KEY, nextSelections);
    if (Object.keys(nextTitles).length !== Object.keys(titles).length) await this.state.update(TITLES_KEY, nextTitles);
    if (Object.keys(nextDrafts).length !== Object.keys(drafts).length) await this.state.update(DRAFTS_KEY, nextDrafts);
    if (pins.some((id) => !ids.has(id))) await this.state.update(PINNED_KEY, pins.filter((id) => ids.has(id)));
    if (favorites.some((id) => !ids.has(id))) await this.state.update(FAVORITES_KEY, favorites.filter((id) => ids.has(id)));
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
