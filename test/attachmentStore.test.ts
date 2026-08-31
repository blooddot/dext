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

  it("uses the configured attachment limit only inside its safe range", () => {
    expect(attachmentByteLimit(MIN_ATTACHMENT_BYTES)).toBe(MIN_ATTACHMENT_BYTES);
    expect(attachmentByteLimit(MAX_CONFIGURED_ATTACHMENT_BYTES)).toBe(MAX_CONFIGURED_ATTACHMENT_BYTES);
    expect(attachmentByteLimit(MIN_ATTACHMENT_BYTES - 1)).toBe(MAX_ATTACHMENT_BYTES);
    expect(attachmentByteLimit(MAX_CONFIGURED_ATTACHMENT_BYTES + 1)).toBe(MAX_ATTACHMENT_BYTES);
  });
});
