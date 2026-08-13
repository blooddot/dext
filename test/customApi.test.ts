import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { loadCustomApis } from "../src/core/customApi.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";

const files = new Map([
  ["C:/workspace/.dext/api/team/explain.dx", `def main(target: Context) -> ChatResult:\n    return chat(message="explain", context=target)\n`],
  ["C:/workspace/.dext/api/team/review.dx", `import team.explain as describe\n\ndef main(target: Context) -> ReviewResult:\n    analysis = describe(target=target)\n    return code.review(target=target, instruction=analysis.text)\n`],
  ["C:/workspace/.dext/api/team/namespace.dx", `import team\n\ndef main(target: Context) -> ChatResult:\n    return team.explain(target=target)\n`]
]);

const host: ContextHost = {
  selection: async () => ({ uri: "file:///selection.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => undefined,
  file: async () => undefined,
  symbol: async () => undefined
};

describe("custom .dx APIs", () => {
  it("loads main signatures and explicit imports", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const result = await loadCustomApis(
      true,
      ["C:/workspace/.dext/api"],
      async () => [...files.keys()],
      async (path) => files.get(path),
      registry
    );
    expect(result.diagnostics).toEqual([]);
    expect(registry.get("team.explain")?.input[0]).toMatchObject({ name: "target", type: "context" });
    expect(registry.get("team.review")?.executor).toEqual({ kind: "custom", apiId: "team.review" });
    expect(result.plans.has("team.review")).toBe(true);
  });

  it("executes a custom API through the existing runtime", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = await loadCustomApis(
      true,
      ["C:/workspace/.dext/api"],
      async () => [...files.keys()],
      async (path) => files.get(path),
      registry
    );
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setCustomPlans(loaded.plans);
    const response = await runtime.execute({
      kind: "invocation",
      method: "team.review",
      source: "code",
      arguments: [{ name: "target", value: { kind: "selection" } }]
    });
    expect(response.result).toMatchObject({ kind: "review", status: "warning" });
  });
});
