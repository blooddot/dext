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
});
