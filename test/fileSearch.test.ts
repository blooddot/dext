import { describe, expect, it, vi } from "vitest";
import { fileMatchScore, rankFileMatches } from "../src/features/workspace/domain/fileSearch.js";

const paths = [
  "README.md",
  "package.json",
  "src/extension.ts",
  "src/app/sidebarProvider.ts",
  "src/fileSearch.ts",
  "src/runtime.ts",
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
    expect(rankFileMatches(paths, "runtime", 3)[0]).toBe("src/runtime.ts");
  });

  it("prefers a basename hit over the same letters buried in directories", () => {
    const ranked = rankFileMatches(paths, "filesearch", 9);
    expect(ranked[0]).toBe("src/fileSearch.ts");
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

const searchHost = vi.hoisted(() => ({ findFiles: vi.fn(), asRelativePath: (uri: { path: string }) => uri.path }));
vi.mock("vscode", () => ({ workspace: searchHost }));

it("search controller suppresses stale responses and disposal during a pending index", async () => {
  const { FileSearchController } = await import("../src/features/workspace/host/fileSearchController.js");
  let release!: (files: Array<{ path: string }>) => void;
  searchHost.findFiles.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const post = vi.fn(async () => {});
  const controller = new FileSearchController(post);
  const first = controller.search({ type: "searchFiles", requestId: 1, query: "old" });
  const second = controller.search({ type: "searchFiles", requestId: 2, query: "new" });
  release([{ path: "src/old.ts" }, { path: "src/new.ts" }, { path: "../outside.ts" }]);
  await Promise.all([first, second]);
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenLastCalledWith({ type: "searchFilesResult", requestId: 2, files: ["src/new.ts"] });
  const pending = controller.search({ type: "searchFiles", requestId: 3, query: "" });
  controller.dispose();
  await pending;
  expect(post).toHaveBeenCalledTimes(1);
  expect(searchHost.findFiles).toHaveBeenCalledWith("**/*", expect.stringContaining("node_modules"), 20000);
});

it("a reopened page can restart request ids while the closed page's index finishes", async () => {
  const { FileSearchController } = await import("../src/features/workspace/host/fileSearchController.js");
  let finishOld!: (files: Array<{ path: string }>) => void;
  searchHost.findFiles.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  const post = vi.fn(async () => {});
  const old = new FileSearchController(post);
  const pending = old.search({ type: "searchFiles", requestId: 9, query: "" });
  old.dispose();
  searchHost.findFiles.mockResolvedValueOnce([{ path: "src/current.ts" }]);
  const current = new FileSearchController(post);
  await current.search({ type: "searchFiles", requestId: 1, query: "" });
  finishOld([{ path: "src/obsolete.ts" }]);
  await pending;
  expect(post.mock.calls).toEqual([[{ type: "searchFilesResult", requestId: 1, files: ["src/current.ts"] }]]);
  current.dispose();
});
