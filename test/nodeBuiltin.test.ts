import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { NODE_BUILTIN_CATALOG } from "../src/core/generated/nodeBuiltinCatalog.js";
import { NODE_MODULE_POLICY } from "../src/core/nodeBuiltinPolicy.js";

describe("whitelisted node builtins", () => {
  it("keeps new callable APIs inside node.* and ui.* namespaces", () => {
    const ids = BUILTIN_METHODS.map((method) => method.id);
    expect(ids).not.toContain("workflow.stop");
    expect(ids).not.toContain("url.last_path_segment");
    expect(ids).toContain("node.url.parse");
    expect(ids).toContain("node.path.basename");
    expect(ids).toContain("node.fs.readFile");
    expect(ids).toContain("node.http.request");
  });

  it("uses original Node export spelling and never catalogs forbidden modules", () => {
    expect(NODE_BUILTIN_CATALOG.map((entry) => entry.method.id)).toContain("node.util.parseArgs");
    for (const entry of NODE_BUILTIN_CATALOG) expect(NODE_MODULE_POLICY.forbidden).not.toContain(entry.module as never);
  });

  it("exposes the fs surface a workflow needs, all of it workspace-bounded", () => {
    const fs = NODE_BUILTIN_CATALOG.filter((entry) => entry.method.id.startsWith("node.fs."));
    expect(fs.map((entry) => entry.method.id)).toEqual([
      "node.fs.readFile", "node.fs.readdir", "node.fs.stat", "node.fs.access", "node.fs.realpath",
      "node.fs.writeFile", "node.fs.appendFile", "node.fs.copyFile", "node.fs.mkdir", "node.fs.rename", "node.fs.rm"
    ]);
    for (const entry of fs) expect(entry.capability).toBe("fs");
  });

  it("sandboxes every fs path argument before Node sees it", () => {
    // nodeBuiltin rewrites an argument only when the field is `path` or ends in
    // `Path`, so a new fs method that names one `src` or `dest` would hand Node
    // an unvalidated path. Non-path inputs must be listed here explicitly.
    const nonPathInputs = new Set(["encoding", "content", "recursive", "force"]);
    for (const entry of NODE_BUILTIN_CATALOG.filter((item) => item.capability === "fs")) {
      const paths = entry.argumentOrder.filter((name) => /(^path$|Path$)/.test(name));
      expect(paths.length).toBeGreaterThan(0);
      expect(entry.argumentOrder.filter((name) => !paths.includes(name)).every((name) => nonPathInputs.has(name))).toBe(true);
    }
  });

  it("binds both node.path.relative arguments and projects node.fs.stat", () => {
    expect(NODE_BUILTIN_CATALOG.find((entry) => entry.method.id === "node.path.relative")!.argumentOrder).toEqual(["from", "to"]);
    expect(NODE_BUILTIN_CATALOG.find((entry) => entry.method.id === "node.path.format")!.argumentOrder).toEqual(["pathObject"]);
    const stat = NODE_BUILTIN_CATALOG.find((entry) => entry.method.id === "node.fs.stat")!;
    expect((stat.method.output.fields ?? []).map((field) => field.name)).toEqual(["size", "mtime_ms", "is_file", "is_directory"]);
    // Stats is a class instance, so the entry must narrow it to plain values.
    expect(stat.project).toBeTypeOf("function");
    expect(stat.project!({ size: 3, mtimeMs: 12.5, isFile: () => true, isDirectory: () => false }))
      .toEqual({ size: 3, mtime_ms: 12.5, is_file: true, is_directory: false });
  });
});
