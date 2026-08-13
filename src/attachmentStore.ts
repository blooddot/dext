import type { CodeRef } from "./core/types.js";

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

interface ClipboardEntry {
  text: string;
  reference: CodeRef;
  expiresAt: number;
}

export class AttachmentStore {
  private clipboard: ClipboardEntry | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  stageClipboard(
    text: string,
    reference: CodeRef
  ): void {
    if (!text) throw new Error("Select code before copying it with context.");
    this.assertSize(reference);
    this.clipboard = {
      text,
      reference,
      expiresAt: this.now() + CLIPBOARD_TTL_MS
    };
  }

  clipboardReference(text: string): CodeRef | undefined {
    return this.matchClipboard(text)?.reference;
  }

  dispose(): void {
    this.clipboard = undefined;
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
