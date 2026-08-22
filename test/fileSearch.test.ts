import { describe, expect, it } from "vitest";
import { fileMatchScore, rankFileMatches } from "../src/core/fileSearch.js";

const paths = [
  "README.md",
  "package.json",
  "src/extension.ts",
  "src/sidebarProvider.ts",
  "src/core/fileSearch.ts",
  "src/core/runtime.ts",
  "src/webview/main.ts",
  "src/webview/codeEditor.ts",
  "test/fileSearch.test.ts"
];

describe("composer file search ranking", () => {
  it("matches a subsequence that crosses directory boundaries", () => {
    // A glob cannot express this, which is why the ranking runs in the host.
    expect(rankFileMatches(paths, "srcmain", 5)).toContain("src/webview/main.ts");
    expect(fileMatchScore("src/webview/main.ts", "srcmain")).toBeTypeOf("number");
    expect(fileMatchScore("src/webview/main.ts", "zzz")).toBeUndefined();
  });

  it("is case insensitive and puts the closest name first", () => {
    expect(rankFileMatches(paths, "READ", 3)[0]).toBe("README.md");
    expect(rankFileMatches(paths, "codeeditor", 3)[0]).toBe("src/webview/codeEditor.ts");
    expect(rankFileMatches(paths, "runtime", 3)[0]).toBe("src/core/runtime.ts");
  });

  it("prefers a basename hit over the same letters buried in directories", () => {
    const ranked = rankFileMatches(paths, "filesearch", 9);
    expect(ranked[0]).toBe("src/core/fileSearch.ts");
    expect(ranked).toContain("test/fileSearch.test.ts");
  });

  it("lists the shallowest paths when nothing has been typed yet", () => {
    // Depth first, then locale order, so root files lead and case does not
    // shuffle them the way a raw code-point sort would.
    expect(rankFileMatches(paths, "", 3)).toEqual(["package.json", "README.md", "src/extension.ts"]);
    expect(rankFileMatches(paths, "   ", 2)).toEqual(["package.json", "README.md"]);
  });

  it("honours the result limit", () => {
    expect(rankFileMatches(paths, "s", 2)).toHaveLength(2);
    expect(rankFileMatches([], "s", 5)).toEqual([]);
  });
});
