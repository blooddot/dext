import { describe, expect, it } from "vitest";
import { presentDiff } from "../src/diffPresentation.js";

describe("Diff presentation", () => {
  it("aligns replacement blocks for inline and split rendering", () => {
    const diff = presentDiff({
      before: "before\nold one\nold two\nafter",
      after: "before\nnew one\nafter"
    });

    expect(diff).toMatchObject({ added: 1, removed: 2 });
    expect(diff.rows).toEqual([
      {
        before: { line: 1, text: "before", kind: "context" },
        after: { line: 1, text: "before", kind: "context" }
      },
      {
        before: { line: 2, text: "old one", kind: "removed" },
        after: { line: 2, text: "new one", kind: "added" }
      },
      { before: { line: 3, text: "old two", kind: "removed" } },
      {
        before: { line: 4, text: "after", kind: "context" },
        after: { line: 3, text: "after", kind: "context" }
      }
    ]);
  });
});
