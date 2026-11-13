import type { AgentSelection } from "../../agents/contracts/agent.js";

/** Conversation-scoped composer preferences. Stored per conversation id, never
 * in the shared sidebar state, so two tabs cannot overwrite each other. */

export interface HistoryOrdering {
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

/** What the composer held for a conversation whose turn was never sent.
 * Attachments keep only the stored reference: the Webview URI is minted again
 * when the draft is handed back to a document. */
export interface ComposerDraft {
  source: string;
  attachments: { relativePath: string; name: string }[];
}

/** The storage surface the conversation controllers depend on. The host
 * implementation adds no other requirement, which keeps the controllers
 * testable without VS Code. */
export interface ConversationPreferences {
  pinned(): string[];
  isPinned(sessionId: string): boolean;
  setPinned(sessionId: string, pinned: boolean): Promise<void>;
  favorites(): string[];
  setFavorite(sessionId: string, favorite: boolean): Promise<void>;
  title(sessionId: string): string | undefined;
  setTitle(sessionId: string, title: string): Promise<void>;
  conversationLayout(): ConversationLayout;
  setConversationLayout(layout: ConversationLayout): Promise<void>;
  conversationSelection(sessionId: string): AgentSelection | undefined;
  setConversationSelection(sessionId: string, selection: AgentSelection): Promise<void>;
  forgetConversationSelection(sessionId: string): Promise<void>;
  /** Every kept draft, so a document that just opened can get all of them. */
  composerDrafts(): Record<string, ComposerDraft>;
  /** An empty draft forgets the conversation's entry. */
  setComposerDraft(sessionId: string, draft: ComposerDraft): Promise<void>;
  favoritesOnly(): boolean;
  archivedOnly(): boolean;
  setArchivedOnly(archivedOnly: boolean): Promise<void>;
  setFavoritesOnly(favoritesOnly: boolean): Promise<void>;
  historyOrdering(): HistoryOrdering;
  forget(sessionId: string): Promise<void>;
}
