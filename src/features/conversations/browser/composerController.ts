/** Composer drafts belong to one conversation tab. Committing a turn clears
 * only that tab's draft; switching tabs saves and restores the right one. */

export interface DraftAttachment {
  relativePath: string;
  webviewUri: string;
  name: string;
}

export interface ConversationDraft {
  source: string;
  attachments: DraftAttachment[];
}

export class ComposerDraftStore {
  private readonly drafts = new Map<string, ConversationDraft>();

  /** Saves the composer text and the attachments it still references. If the
   * user removes an image's @ reference directly in the editor, the chip is not
   * resurrected when returning to this tab. */
  save(sessionId: string, source: string, attachments: readonly DraftAttachment[]): void {
    this.drafts.set(sessionId, {
      source,
      attachments: attachments
        .filter((item) => source.includes(`@${item.relativePath}`))
        .map((item) => ({ ...item }))
    });
  }

  draft(sessionId: string): ConversationDraft | undefined {
    return this.drafts.get(sessionId);
  }

  /** A draft that the reader never sent - text or a referenced image. */
  hasUnsent(sessionId: string): boolean {
    const draft = this.drafts.get(sessionId);
    return Boolean(draft?.source.trim() || draft?.attachments.length);
  }

  delete(sessionId: string): void {
    this.drafts.delete(sessionId);
  }

  clear(): void {
    this.drafts.clear();
  }
}
