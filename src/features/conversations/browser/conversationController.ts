import type { DextHistorySession } from "../contracts/history.js";
import type { ConversationSummary } from "../contracts/protocol.js";

/** Identity and render generation for the browser conversation view. The
 * Webview can receive a delayed IPC payload after the reader selected another
 * tab, so every asynchronous render callsite compares its generation and the
 * switch id it was created for. */
export class ConversationBrowser {
  /** The tab the reader selected locally. */
  activeId: string | undefined;
  /** Monotonically identifies the latest tab click. */
  switchId = 0;
  /** Rendering a restored conversation can include Markdown, highlighting and
   * diffs; keep the switch responsive by invalidating older deferred renders. */
  renderGeneration = 0;
  /** The conversation whose DOM is currently painted in the result pane. */
  renderedId: string | undefined;
  /** Signature of that painted DOM, used to restore it from the view cache. */
  renderedSignature: string | undefined;

  /** Commits a tab press locally and returns the id its responses must carry. */
  beginSelection(sessionId: string): number {
    this.activeId = sessionId;
    return ++this.switchId;
  }

  /** Host messages without a switch id must not undo a committed local press. */
  acceptsHostActiveId(activeId: string, hostInitiated: boolean, switchId: number | undefined): boolean {
    if (switchId !== undefined) return switchId === this.switchId;
    return hostInitiated || !this.activeId || activeId === this.activeId;
  }

  setActiveId(activeId: string): boolean {
    const changed = this.activeId !== activeId;
    this.activeId = activeId;
    return changed;
  }

  /** Starts a render and returns the generation a deferred callback checks. */
  beginRender(): number {
    return ++this.renderGeneration;
  }

  isCurrentRender(generation: number, sessionId: string): boolean {
    return generation === this.renderGeneration && this.activeId === sessionId && this.renderedId === sessionId;
  }

  setRendered(sessionId: string, signature: string): void {
    this.renderedId = sessionId;
    this.renderedSignature = signature;
  }

  clearRendered(): void {
    this.renderedId = undefined;
    this.renderedSignature = undefined;
  }

  matchesRendered(sessionId: string, signature: string): boolean {
    return this.renderedId === sessionId && this.renderedSignature === signature;
  }
}

/** A stable identity for the DOM of one conversation. */
export function conversationSignature(session: DextHistorySession): string {
  const last = session.turns.at(-1);
  return `${session.updatedAt}:${session.turns.length}:${last?.id ?? ""}:${last?.process.length ?? 0}`;
}

/** Keep the rendered DOM for recently visited conversations. Rebuilding a long
 * conversation means reparsing every process event and rerendering every diff,
 * which made an ordinary tab switch scale with conversation size. */
export const MAX_CONVERSATION_VIEW_CACHE = 6;

export interface CachedConversationView {
  signature: string;
}

/** Re-inserting a cached conversation makes it the most recently used entry. */
export function putConversationView<T extends CachedConversationView>(
  cache: Map<string, T>,
  sessionId: string,
  view: T
): void {
  cache.delete(sessionId);
  cache.set(sessionId, view);
  while (cache.size > MAX_CONVERSATION_VIEW_CACHE) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/** Recently visited conversation DOM. The controller owns the cache and its
 * eviction order; the payload is whatever the transcript renderer needs, so the
 * browser controller never imports transcript internals. */
export class ConversationViewStore<T extends CachedConversationView> {
  private readonly views = new Map<string, T>();

  get(sessionId: string): T | undefined {
    return this.views.get(sessionId);
  }

  /** Re-inserting a cached conversation makes it the most recently used entry. */
  put(sessionId: string, view: T): void {
    putConversationView(this.views, sessionId, view);
  }

  delete(sessionId: string): void {
    this.views.delete(sessionId);
  }

  clear(): void {
    this.views.clear();
  }

  get size(): number {
    return this.views.size;
  }
}

export function takeConversationView<T>(cache: Map<string, T>, sessionId: string): T | undefined {
  return cache.get(sessionId);
}

/** The host can deliver a trimmed or reordered tab strip; the tab actions still
 * address conversations by id, never by position. */
export function conversationTabIds(sessions: readonly ConversationSummary[]): string[] {
  return sessions.map((session) => session.id);
}
