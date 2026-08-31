import type { DextFileReference } from "./core/fileReference.js";

/** Default ceiling for content Dext persists from the clipboard or terminal. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MIN_ATTACHMENT_BYTES = 64 * 1024;
export const MAX_CONFIGURED_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const CLIPBOARD_TTL_MS = 60_000;

export function attachmentByteLimit(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_ATTACHMENT_BYTES
    && value <= MAX_CONFIGURED_ATTACHMENT_BYTES
    ? value
    : MAX_ATTACHMENT_BYTES;
}

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
  reference: DextFileReference;
  expiresAt: number;
}

export class AttachmentStore {
  private clipboard: ClipboardEntry | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  stageClipboard(
    text: string,
    reference: DextFileReference
  ): void {
    if (!text) throw new Error("Select text before copying it with context.");
    this.assertSize(text);
    this.clipboard = {
      text,
      reference,
      expiresAt: this.now() + CLIPBOARD_TTL_MS
    };
  }

  clipboardReference(text: string): DextFileReference | undefined {
    return this.matchClipboard(text)?.reference;
  }

  clearClipboard(): void {
    this.clipboard = undefined;
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

  private assertSize(text: string): void {
    if (new TextEncoder().encode(text).byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments must be ${MAX_ATTACHMENT_BYTES} bytes or smaller.`);
    }
  }
}
