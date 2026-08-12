import { describe, expect, it } from "vitest";
import {
  AttachmentStore,
  CLIPBOARD_TTL_MS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  writeExactClipboardText
} from "../src/attachmentStore.js";
import type { CodeRef } from "../src/core/types.js";

function codeRef(content = "const value = 1;", uri = "file:///src/value.ts"): CodeRef {
  return {
    kind: "codeRef",
    uri,
    documentVersion: 1,
    contentHash: `hash:${content}`,
    content
  };
}

function view(uri = "file:///src/value.ts") {
  return { kind: "code" as const, label: "value.ts L1", uri };
}

describe("AttachmentStore", () => {
  it("passes the exact selected text to the clipboard writer", async () => {
    const writes: string[] = [];
    const selectedText = "  first line\r\nsecond line\t";

    await expect(writeExactClipboardText({
      writeText: async (text) => {
        writes.push(text);
      }
    }, selectedText)).resolves.toBe(selectedText);
    expect(writes).toEqual([selectedText]);
  });

  it("keeps code snapshots private while exposing opaque attachment metadata", () => {
    const store = new AttachmentStore(() => "attachment-1");
    const added = store.add(view(), codeRef());

    expect(added).toEqual({ id: "attachment-1", ...view() });
    expect(store.list()).toEqual([added]);
    expect(store.view(added.id)).toEqual(added);
    expect(store.view("missing")).toBeUndefined();
    expect(added).not.toHaveProperty("content");
    expect(added).not.toHaveProperty("contentHash");
    expect(store.resolve([added.id])).toEqual([codeRef()]);
  });

  it("rejects duplicate, missing, oversized, and excess attachments", () => {
    let nextId = 0;
    const store = new AttachmentStore(() => `attachment-${++nextId}`);
    const first = store.add(view(), codeRef());

    expect(() => store.resolve([first.id, first.id])).toThrow("unique");
    expect(() => store.resolve(["missing"])).toThrow("missing or expired");
    expect(() => store.add(view(), codeRef("a".repeat(MAX_ATTACHMENT_BYTES + 1))))
      .toThrow("bytes or smaller");

    for (let index = 1; index < MAX_ATTACHMENTS; index += 1) {
      store.add(view(`file:///src/${index}.ts`), codeRef(String(index), `file:///src/${index}.ts`));
    }
    expect(() => store.add(view("file:///src/overflow.ts"), codeRef("overflow")))
      .toThrow(`at most ${MAX_ATTACHMENTS}`);
  });

  it("reuses an exact staged clipboard snapshot and invalidates it on mismatch or expiry", () => {
    let now = 1_000;
    let nextId = 0;
    const store = new AttachmentStore(() => `attachment-${++nextId}`, () => now);
    store.stageClipboard("selected text", view(), codeRef("selected text"));

    expect(store.consumeClipboard("selected text")).toEqual({ id: "attachment-1", ...view() });
    expect(store.consumeClipboard("selected text")).toEqual({ id: "attachment-2", ...view() });
    expect(store.consumeClipboard("different text")).toBeUndefined();
    expect(store.consumeClipboard("selected text")).toBeUndefined();

    store.stageClipboard("selected text", view(), codeRef("selected text"));
    now += CLIPBOARD_TTL_MS + 1;
    expect(store.consumeClipboard("selected text")).toBeUndefined();
  });

  it("reuses staged code context without adding a Chat attachment", () => {
    const store = new AttachmentStore(() => "attachment-1");
    const reference = codeRef("selected text");
    store.stageClipboard("selected text", view(), reference);

    expect(store.consumeClipboardReference("selected text")).toEqual(reference);
    expect(store.list()).toEqual([]);
    expect(store.consumeClipboardReference("selected text")).toEqual(reference);
  });

  it("removes sent attachments without affecting the remaining snapshots", () => {
    let nextId = 0;
    const store = new AttachmentStore(() => `attachment-${++nextId}`);
    const first = store.add(view("file:///first.ts"), codeRef("first", "file:///first.ts"));
    const second = store.add(view("file:///second.ts"), codeRef("second", "file:///second.ts"));

    store.clear([first.id]);
    expect(store.list()).toEqual([second]);
    store.remove(second.id);
    expect(store.list()).toEqual([]);
  });
});
