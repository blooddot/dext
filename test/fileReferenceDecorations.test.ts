import { describe, expect, it } from "vitest";
import {
  atReferenceOccurrences,
  inputReferenceProjections,
  normalizeInputReferenceSource
} from "../src/core/fileReference.js";
import { inputReferenceProjectionDecorations } from "../src/webview/fileReferenceDecorations.js";
import { fileReferenceRemovalEdit } from "../src/webview/fileReferenceDecorations.js";

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
    expect(ranges).toEqual([{ from: source.indexOf(" " + token), to: source.indexOf(token) + token.length + 1 }]);
    expect(fileReferenceRemovalEdit(source, projection[0]!)).toEqual({
      from: source.indexOf(" " + token),
      to: source.indexOf(token) + token.length + 1,
      insert: " "
    });
  });

  it("keeps spaces typed after a Chip outside its atomic range", () => {
    const token = "@src/pathx.py";
    // The first space is the automatically inserted path separator. The
    // second represents a space the user typed after the reference.
    const source = `agent(input="${token}  后续")`;
    const ranges: Array<{ from: number; to: number }> = [];
    inputReferenceProjectionDecorations(source, () => {}).between(0, source.length, (from, to) => {
      ranges.push({ from, to });
    });
    expect(ranges).toEqual([{
      from: source.indexOf(token),
      to: source.indexOf(token) + token.length + 1
    }]);
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

  it("recognizes trailing-slash directory references as folder Chips", () => {
    const [directory] = atReferenceOccurrences('agent(input="Inspect @src/components/")');
    expect(directory).toMatchObject({
      kind: "dir",
      expression: "@src/components/",
      payload: "src/components"
    });
  });

  it("removes an initial chip and its separator without leaving a leading blank", () => {
    const token = "@.dext/attachments/0123456789abcdef01234567.png";
    const source = `ask(input="${token} 后续文字")`;
    const [projection] = inputReferenceProjections(source);
    expect(projection).toBeDefined();
    expect(fileReferenceRemovalEdit(source, projection!)).toEqual({
      from: source.indexOf(token),
      to: source.indexOf(token) + token.length + 1,
      insert: ""
    });
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
