import { describe, expect, it } from "vitest";
import { compareProjectBaselines } from "../src/core/projectChanges.js";

describe("project change baselines", () => {
  it("classifies created, modified and deleted files", () => {
    const result = compareProjectBaselines(
      [{ path: "a.ts", contentHash: "a", exists: true }, { path: "b.py", contentHash: "b", exists: true }],
      [{ path: "a.ts", contentHash: "c", exists: true }, { path: "c.rs", contentHash: "c", exists: true }]
    );
    expect(result.map((item) => [item.path, item.kind])).toEqual([["a.ts", "modified"], ["b.py", "deleted"], ["c.rs", "created"]]);
  });
});
