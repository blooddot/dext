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

/** Copy Path writes the path text Dext reads, but the command that runs after it
 * owns the clipboard: an Explorer paste needs VS Code's file list, which carries
 * no text, and a copy-line replaces it with the line. The paths survive here for
 * the next paste that would have read them. */
interface FileCopyEntry {
  paths: string;
  clipboardText: string;
  expiresAt: number;
}

export class AttachmentStore {
  private clipboard: ClipboardEntry | undefined;
  private fileCopy: FileCopyEntry | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  stageClipboard(
    text: string,
    reference: DextFileReference
  ): void {
    if (!text) throw new Error("Select text before copying it with context.");
    this.assertSize(text);
    this.fileCopy = undefined;
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

  /** Copy Path runs first, so the path text is what the clipboard holds while
   * Dext stages it. `clipboardText` is what the command that runs last leaves
   * behind, so only that copy can consume the paths. */
  stageFileCopy(paths: string, clipboardText = ""): void {
    if (!paths) {
      this.fileCopy = undefined;
      return;
    }
    this.assertSize(paths);
    this.clipboard = undefined;
    this.fileCopy = {
      paths,
      clipboardText,
      expiresAt: this.now() + CLIPBOARD_TTL_MS
    };
  }

  /** The staged paths only stand in for a clipboard that still holds the copy
   * Dext staged them for: VS Code's file list has no text of its own, and a
   * copy-line holds the line. Any other text is a different copy, which retires
   * the entry. */
  stagedFilePath(clipboardText: string): string | undefined {
    const fileCopy = this.fileCopy;
    if (!fileCopy) return undefined;
    if (fileCopy.expiresAt < this.now() || fileCopy.clipboardText !== clipboardText) {
      this.fileCopy = undefined;
      return undefined;
    }
    return fileCopy.paths;
  }

  dispose(): void {
    this.clipboard = undefined;
    this.fileCopy = undefined;
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
