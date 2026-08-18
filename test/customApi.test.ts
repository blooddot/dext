import { describe, expect, it } from "vitest";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { loadCustomApis } from "../src/core/customApi.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { AxAdapter } from "../src/core/axAdapter.js";

const files = new Map([
  ["C:/workspace/.dext/api/team/explain.dx", `def main(input: str) -> ChatResult:\n    return ask(input=input)\n`],
  ["C:/workspace/.dext/api/team/review.dx", `import team.explain as describe\n\ndef main(input: str) -> ChatResult:\n    return describe(input=input)\n`],
  ["C:/workspace/.dext/api/team/namespace.dx", `import team\n\ndef main(input: str) -> ChatResult:\n    return team.explain(input=input)\n`]
]);

const host: ContextHost = {
  selection: async () => ({ uri: "file:///selection.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => undefined,
  file: async () => undefined,
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
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
    expect(registry.get("team.explain")?.input[0]).toMatchObject({ name: "input", type: "string" });
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
      arguments: [{ name: "input", value: "explain this" }]
    });
    expect(response.result).toMatchObject({ kind: "chat", text: "explain this" });
  });

  it("registers a restricted TypedDict result as a JSON schema contract", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const typed = new Map([["C:/workspace/.dext/api/docs/read.dx", `from typing import Literal, NotRequired, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str
    title: NotRequired[str]

def main(input: str) -> DocumentResult:
    return print(text=input)
`]]);
    const loaded = await loadCustomApis(
      true,
      ["C:/workspace/.dext/api"],
      async () => [...typed.keys()],
      async (path) => typed.get(path),
      registry
    );
    expect(loaded.diagnostics).toEqual([]);
    const method = registry.get("docs.read")!;
    expect(method.output).toMatchObject({ kind: "document", resultType: "DocumentResult" });
    expect(method.output.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "uri", type: "string", required: true }),
      expect.objectContaining({ name: "title", type: "string", required: false })
    ]));
    const contract = new AxAdapter().compile(method);
    expect(contract.outputSchema.parse({ kind: "document", uri: "dext://doc/1", content: "body" }))
      .toMatchObject({ kind: "document", content: "body" });
    expect(() => contract.outputSchema.parse({ kind: "document", uri: "dext://doc/1" })).toThrow();
  });

  it("adapts mcp structuredContent into a TypedDict result before validating it", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const typed = new Map([["C:/workspace/.dext/api/docs/read.dx", `from typing import Literal, TypedDict

class DocumentResult(TypedDict):
    kind: Literal["document"]
    uri: str
    content: str

def main(input: dict[str, object]) -> DocumentResult:
    return mcp(tool="docs.read", input=input)
`]]);
    const loaded = await loadCustomApis(
      true,
      ["C:/workspace/.dext/api"],
      async () => [...typed.keys()],
      async (path) => typed.get(path),
      registry
    );
    expect(loaded.diagnostics).toEqual([]);
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setWorkspaceTrusted(true);
    runtime.setCustomPlans(loaded.plans);
    runtime.setMcpCaller(async () => ({
      kind: "mcpRaw",
      server: "docs",
      tool: "read",
      structured: { uri: "file:///workspace/readme.md", content: "# Readme" }
    }));

    const response = await runtime.execute({
      kind: "invocation",
      method: "docs.read",
      source: "code",
      arguments: [{ name: "input", value: { uri: "readme.md" } }]
    });
    expect(response.result).toEqual({
      kind: "document",
      uri: "file:///workspace/readme.md",
      content: "# Readme"
    });
  });
});
