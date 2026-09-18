import { describe, expect, it } from "vitest";
import {
  atReferenceOccurrences,
  inputReferenceProjections,
  normalizeInputReferenceSource
} from "../src/core/fileReference.js";
import { inputReferenceProjectionDecorations } from "../src/webview/fileReferenceDecorations.js";

describe("@ file reference decorations", () => {
  it("projects a readable @path token as one atomic Chip range", () => {
    const token = "@src/pathx.py#L55,1-L66,32";
    const source = 'agent(input="说明 ' + token + ' 后续")';
    const projection = inputReferenceProjections(source);
    expect(projection).toMatchObject([{ reference: { kind: "file", payload: "src/pathx.py#L55,1-L66,32" } }]);
    const ranges: Array<{ from: number; to: number }> = [];
    inputReferenceProjectionDecorations(source, () => {}).between(0, source.length, (from, to) => {
      ranges.push({ from, to });
    });
    expect(ranges).toEqual([{ from: source.indexOf(token), to: source.indexOf(token) + token.length }]);
  });

  it("only recognizes workspace-relative paths with valid ranges", () => {
    const values = atReferenceOccurrences([
      "@src/a.ts",
      "person@example.com",
      "@mention",
      "@src/a.ts#L4,1-L3,1",
      "@src/a.ts#L4,1-Lx,1",
      "@../secret.ts"
    ].join(" "));
    expect(values.map((item) => item.payload)).toEqual(["src/a.ts"]);
  });

  it("migrates legacy marker, f-string, and broken nested input to readable @ tokens", () => {
    const marker = "\uE000eyJraW5kIjoiZmlsZSIsInBheWxvYWQiOiJzcmMvYS50cyJ9\uE001";
    const fString = 'agent(input=f"Read {ref.file(\'src/a.ts\')}")';
    const broken = 'agent(input="Read ref.file("src/a.ts")")';
    for (const source of ['agent(input="Read ' + marker + '")', fString, broken]) {
      const migrated = normalizeInputReferenceSource(source);
      expect(migrated).toBe('agent(input="Read @src/a.ts")');
    }
    expect(normalizeInputReferenceSource('print(text="ref.file("src/a.ts")")'))
      .toBe('print(text="ref.file("src/a.ts")")');
  });
});
