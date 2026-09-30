import { describe, expect, it } from "vitest";
import {
  AttachmentStore,
  CLIPBOARD_TTL_MS,
  attachmentByteLimit,
  MAX_CONFIGURED_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES,
  MIN_ATTACHMENT_BYTES,
  writeExactClipboardText
} from "../src/attachmentStore.js";
import type { DextFileReference } from "../src/core/fileReference.js";

function codeRef(content = "const value = 1;"): DextFileReference {
  return {
    payload: `src/value.ts#${content.length}`,
    expression: `@src/value.ts#${content.length}`
  };
}

describe("AttachmentStore", () => {
  it("passes the exact selected text to the clipboard writer", async () => {
    const writes: string[] = [];
    const selectedText = "  first line\r\nsecond line\t";
    await expect(writeExactClipboardText({
      writeText: async (text) => { writes.push(text); }
    }, selectedText)).resolves.toBe(selectedText);
    expect(writes).toEqual([selectedText]);
  });

  it("matches staged context repeatedly without consuming it", () => {
    const store = new AttachmentStore();
    const reference = codeRef("selected text");
    store.stageClipboard("selected text", reference);
    expect(store.clipboardReference("selected text")).toBe(reference);
    expect(store.clipboardReference("selected text")).toBe(reference);
  });

  it("invalidates staged context on mismatch or expiry", () => {
    let now = 1_000;
    const store = new AttachmentStore(() => now);
    store.stageClipboard("selected text", codeRef("selected text"));
    expect(store.clipboardReference("different text")).toBeUndefined();
    expect(store.clipboardReference("selected text")).toBeUndefined();

    store.stageClipboard("selected text", codeRef("selected text"));
    now += CLIPBOARD_TTL_MS + 1;
    expect(store.clipboardReference("selected text")).toBeUndefined();
  });

  it("rejects oversized staged context", () => {
    const store = new AttachmentStore();
    const text = "a".repeat(MAX_ATTACHMENT_BYTES + 1);
    expect(() => store.stageClipboard(
      text,
      codeRef(text)
    )).toThrow("bytes or smaller");
  });

  it("keeps Copy Path text while VS Code's own copy holds the clipboard", () => {
    const store = new AttachmentStore();
    const paths = "C:\\repo\\a.ts\nC:\\repo\\b.ts";
    // The file list an Explorer paste reads carries no text of its own.
    store.stageFileCopy(paths);
    expect(store.stagedFilePath("")).toBe(paths);
    expect(store.stagedFilePath("")).toBe(paths);
    // A copy-line leaves the line behind, and that line is the same copy.
    store.stageFileCopy("C:\\repo\\a.ts", "const value = 1;");
    expect(store.stagedFilePath("const value = 1;")).toBe("C:\\repo\\a.ts");
  });

  it("retires staged Copy Path text once the clipboard carries a different copy", () => {
    const store = new AttachmentStore();
    store.stageFileCopy("/repo/a.ts", "const value = 1;");
    expect(store.stagedFilePath("copied text")).toBeUndefined();
    expect(store.stagedFilePath("const value = 1;")).toBeUndefined();
  });

  it("expires staged Copy Path text, drops it when nothing was copied, and clears it for a selection copy", () => {
    let now = 1_000;
    const store = new AttachmentStore(() => now);
    store.stageFileCopy("/repo/a.ts");
    now += CLIPBOARD_TTL_MS + 1;
    expect(store.stagedFilePath("")).toBeUndefined();

    store.stageFileCopy("");
    expect(store.stagedFilePath("")).toBeUndefined();

    store.stageFileCopy("/repo/a.ts");
    store.stageClipboard("selected text", codeRef("selected text"));
    expect(store.stagedFilePath("")).toBeUndefined();
    expect(store.clipboardReference("selected text")).toEqual(codeRef("selected text"));
  });

  it("rejects oversized Copy Path text", () => {
    const store = new AttachmentStore();
    expect(() => store.stageFileCopy("a".repeat(MAX_ATTACHMENT_BYTES + 1)))
      .toThrow("bytes or smaller");
  });

  it("uses the configured attachment limit only inside its safe range", () => {
    expect(attachmentByteLimit(MIN_ATTACHMENT_BYTES)).toBe(MIN_ATTACHMENT_BYTES);
    expect(attachmentByteLimit(MAX_CONFIGURED_ATTACHMENT_BYTES)).toBe(MAX_CONFIGURED_ATTACHMENT_BYTES);
    expect(attachmentByteLimit(MIN_ATTACHMENT_BYTES - 1)).toBe(MAX_ATTACHMENT_BYTES);
    expect(attachmentByteLimit(MAX_CONFIGURED_ATTACHMENT_BYTES + 1)).toBe(MAX_ATTACHMENT_BYTES);
  });
});
