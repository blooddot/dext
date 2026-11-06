import { describe, expect, it } from "vitest";
import { isIgnored, parseIgnoreRules } from "../src/features/workspace/domain/ignoreRules.js";

/** The matcher decides whether a result assertion may claim a file is ignored,
 * so each gitignore form it supports is pinned here. */
const ignored = (content: string, path: string): boolean => isIgnored(parseIgnoreRules(content), path);

describe("gitignore matching", () => {
  it("matches a bare name at any depth", () => {
    expect(ignored("node_modules", "node_modules/react/index.js")).toBe(true);
    expect(ignored("node_modules", "packages/app/node_modules/react/index.js")).toBe(true);
    expect(ignored("node_modules", "src/node_modules.ts")).toBe(false);
  });

  it("matches a wildcard extension at any depth", () => {
    expect(ignored("*.log", "debug.log")).toBe(true);
    expect(ignored("*.log", "logs/debug.log")).toBe(true);
    expect(ignored("*.log", "debug.log.txt")).toBe(false);
  });

  it("anchors a leading slash to the root", () => {
    expect(ignored("/dist", "dist/bundle.js")).toBe(true);
    expect(ignored("/dist", "src/dist/bundle.js")).toBe(false);
  });

  it("spans directories with a double star", () => {
    expect(ignored("src/**/test.ts", "src/test.ts")).toBe(true);
    expect(ignored("src/**/test.ts", "src/a/b/test.ts")).toBe(true);
    expect(ignored("src/**/test.ts", "srcs/test.ts")).toBe(false);
  });

  it("excludes everything below a directory-only pattern", () => {
    expect(ignored("build/", "build")).toBe(true);
    expect(ignored("build/", "build/out/app.js")).toBe(true);
    expect(ignored("build/", "src/build/out/app.js")).toBe(true);
  });

  it("lets a later negation re-include a file", () => {
    const rules = "*.log\n!keep.log";
    expect(ignored(rules, "other.log")).toBe(true);
    expect(ignored(rules, "keep.log")).toBe(false);
    expect(ignored(rules, "logs/keep.log")).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    expect(parseIgnoreRules("# node_modules\n\n   \n")).toEqual([]);
    expect(ignored("# node_modules\n\n", "node_modules/x.js")).toBe(false);
  });

  it("keeps an empty file permissive and normalizes Windows separators", () => {
    expect(parseIgnoreRules("")).toEqual([]);
    expect(ignored("", "anything.txt")).toBe(false);
    expect(ignored("*.log", "logs\\debug.log")).toBe(true);
  });
});
