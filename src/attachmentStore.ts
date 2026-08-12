import { randomUUID } from "node:crypto";
import type { CodeRef, Range } from "./core/types.js";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
export const CLIPBOARD_TTL_MS = 60_000;

export interface TextClipboardWriter {
  writeText(text: string): Thenable<void>;
}

export async function writeExactClipboardText(
  writer: TextClipboardWriter,
  text: string
): Promise<string> {
  await writer.writeText(text);
  return text;
}

export interface AttachmentView {
  id: string;
  kind: "code" | "file";
  label: string;
  uri: string;
  range?: Range;
}

interface AttachmentEntry {
  view: AttachmentView;
  reference: CodeRef;
}

interface ClipboardEntry {
  text: string;
  view: Omit<AttachmentView, "id">;
  reference: CodeRef;
  expiresAt: number;
}

export class AttachmentStore {
  private readonly entries = new Map<string, AttachmentEntry>();
  private clipboard: ClipboardEntry | undefined;

  constructor(
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now
  ) {}

  list(): AttachmentView[] {
    return [...this.entries.values()].map((entry) => entry.view);
  }

  add(view: Omit<AttachmentView, "id">, reference: CodeRef): AttachmentView {
    this.assertCapacity(reference);
    const stored = { ...view, id: this.createId() } satisfies AttachmentView;
    this.entries.set(stored.id, { view: stored, reference });
    return stored;
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  view(id: string): AttachmentView | undefined {
    return this.entries.get(id)?.view;
  }

  resolve(ids: readonly string[]): CodeRef[] {
    if (new Set(ids).size !== ids.length) throw new Error("Attachment IDs must be unique.");
    return ids.map((id) => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error("An attachment is missing or expired. Add it again before sending.");
      return entry.reference;
    });
  }

  clear(ids: readonly string[]): void {
    ids.forEach((id) => this.entries.delete(id));
  }

  stageClipboard(
    text: string,
    view: Omit<AttachmentView, "id">,
    reference: CodeRef
  ): void {
    if (!text) throw new Error("Select code before copying it with context.");
    this.assertSize(reference);
    this.clipboard = {
      text,
      view,
      reference,
      expiresAt: this.now() + CLIPBOARD_TTL_MS
    };
  }

  consumeClipboard(text: string): AttachmentView | undefined {
    const clipboard = this.matchClipboard(text);
    if (!clipboard) return undefined;
    const attached = this.add(clipboard.view, clipboard.reference);
    return attached;
  }

  clipboardReference(text: string): CodeRef | undefined {
    return this.matchClipboard(text)?.reference;
  }

  consumeClipboardReference(text: string): CodeRef | undefined {
    return this.clipboardReference(text);
  }

  dispose(): void {
    this.entries.clear();
    this.clipboard = undefined;
  }

  private assertCapacity(reference: CodeRef): void {
    if (this.entries.size >= MAX_ATTACHMENTS) {
      throw new Error(`Chat supports at most ${MAX_ATTACHMENTS} attachments.`);
    }
    this.assertSize(reference);
  }

  private matchClipboard(text: string): ClipboardEntry | undefined {
    const clipboard = this.clipboard;
    if (!clipboard) return undefined;
    if (clipboard.expiresAt < this.now()) {
      this.clipboard = undefined;
      return undefined;
    }
    if (clipboard.text !== text) {
      this.clipboard = undefined;
      return undefined;
    }
    return clipboard;
  }

  private assertSize(reference: CodeRef): void {
    if (new TextEncoder().encode(reference.content).byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments must be ${MAX_ATTACHMENT_BYTES} bytes or smaller.`);
    }
  }
}
