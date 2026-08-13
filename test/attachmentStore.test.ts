import { describe, expect, it } from "vitest";
import {
  AttachmentStore,
  CLIPBOARD_TTL_MS,
  MAX_ATTACHMENT_BYTES,
  writeExactClipboardText
} from "../src/attachmentStore.js";
import type { CodeRef } from "../src/core/types.js";

function codeRef(content = "const value = 1;"): CodeRef {
  return {
    kind: "codeRef",
    uri: "file:///src/value.ts",
    documentVersion: 1,
    contentHash: `hash:${content}`,
    content
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
    expect(() => store.stageClipboard(
      "selected text",
      codeRef("a".repeat(MAX_ATTACHMENT_BYTES + 1))
    )).toThrow("bytes or smaller");
  });
});
