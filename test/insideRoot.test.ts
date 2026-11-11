import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { insideRoot } from "../src/platform/node/insideRoot.js";

const root = join(process.cwd(), "workspace");

describe("insideRoot", () => {
  it("accepts the root itself unless it is excluded", () => {
    expect(insideRoot(root, root)).toBe(true);
    expect(insideRoot(root, join(root, "."))).toBe(true);
    expect(insideRoot(root, root, { allowRoot: false })).toBe(false);
  });

  it("accepts paths below the root, including names that start with dots", () => {
    expect(insideRoot(root, join(root, "a", "b.ts"))).toBe(true);
    expect(insideRoot(root, join(root, "..cache", "build.md"))).toBe(true);
  });

  it("rejects escapes and absolute paths from another drive", () => {
    expect(insideRoot(root, join(root, "..", "x.ts"))).toBe(false);
    expect(insideRoot(root, "..")).toBe(false);
    expect(insideRoot(root, "D:/x.ts")).toBe(false);
  });
});
