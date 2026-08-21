import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { loadCustomApis } from "../src/core/customApi.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { AxAdapter } from "../src/core/axAdapter.js";
import type { UiInteraction } from "../src/core/types.js";

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

  it("loads the selected rules for each nested Agent call", async () => {
    const apiPath = join(process.cwd(), ".dext", "api", "dev", "phase.dx");
    const firstPath = join(process.cwd(), ".dext", "rules", "dev", "first.md");
    const secondPath = join(process.cwd(), ".dext", "rules", "dev", "second.md");
    const sidecarFiles = new Map([
      [apiPath, `def main(input: str) -> AgentResult:\n    first = agent(input=input, apply=False, rules=["dev/first.md"])\n    return agent(input=first.text, apply=False, rules=["dev/second.md"])\n`],
      [firstPath, "Only inspect the request."],
      [secondPath, "Only summarize the inspection."]
    ]);
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = await loadCustomApis(
      true,
      [join(process.cwd(), ".dext", "api", "dev")],
      async () => [...sidecarFiles.keys()],
      async (path) => sidecarFiles.get(path),
      registry
    );
    expect(loaded.diagnostics).toEqual([]);
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setWorkspaceTrusted(true);
    runtime.setCustomPlans(loaded.plans);
    runtime.setRuleLoader(async (path) => sidecarFiles.get(path));
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    const instructions: string[] = [];
    runtime.setAgentRunner({
      run: async (request) => {
        instructions.push(request.metadata.instruction ?? "");
        return { kind: "agent", text: instructions.length === 1 ? "inspected" : "summarized" };
      }
    });
    const response = await runtime.execute({
      kind: "invocation",
      method: "dev.phase",
      source: "code",
      arguments: [{ name: "input", value: "request" }]
    });
    expect(response.result).toMatchObject({ kind: "agent", text: "summarized" });
    expect(instructions).toEqual([
      "Apply rule 'dev/first.md':\n\nOnly inspect the request.",
      "Apply rule 'dev/second.md':\n\nOnly summarize the inspection."
    ]);
  });

  it("discovers only the three project-level development APIs", async () => {
    const apiRoot = join(process.cwd(), ".dext", "api");
    const entries = await readdir(apiRoot, { recursive: true, withFileTypes: true });
    const apiPaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".dx"))
      .map((entry) => join(entry.parentPath, entry.name));
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = await loadCustomApis(
      true,
      [apiRoot],
      async () => apiPaths,
      async (path) => readFile(path, "utf8"),
      registry
    );
    expect(loaded.diagnostics).toEqual([]);
    expect([...loaded.plans.keys()].sort()).toEqual(["dev.feat", "dev.fix", "dev.plan"]);
    expect(loaded.files.find((file) => file.id === "dev.feat")?.source)
      .toContain('rules=["dev/feat.md", "dev/feat/read_context.md"]');
    expect(loaded.files.find((file) => file.id === "dev.fix")?.source)
      .toContain('rules=["dev/fix.md", "dev/fix/parse.md"]');
    expect(loaded.files.find((file) => file.id === "dev.plan")?.source)
      .toContain('rules=["dev/plan.md", "dev/plan/detect.md"]');
  });

  it("orchestrates dev.feat directly through Agent and ui.confirm", async () => {
    const apiRoot = join(process.cwd(), ".dext", "api");
    const entries = await readdir(apiRoot, { recursive: true, withFileTypes: true });
    const paths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".dx"))
      .map((entry) => join(entry.parentPath, entry.name));
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = await loadCustomApis(
      true,
      [apiRoot],
      async () => paths,
      async (path) => readFile(path, "utf8"),
      registry
    );
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setWorkspaceTrusted(true);
    runtime.setCustomPlans(loaded.plans);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    const agentInputs: string[] = [];
    runtime.setAgentRunner({
      run: async (request) => {
        const input = request.resolved.arguments.input;
        agentInputs.push(typeof input === "string" ? input : "");
        return {
          kind: "agent",
          text: ["context summary", "confirmed implementation plan", "implemented changes", "validated changes"][agentInputs.length - 1]!
        };
      }
    });
    const confirmations: string[] = [];
    const ui: UiInteraction = {
        choose: async () => ({ kind: "ui", type: "choice", selected: [] as string[] }),
        confirm: async ({ message }: { message: string }) => {
          confirmations.push(message);
          return { kind: "ui", type: "confirm", confirmed: true };
        },
        input: async () => ({ kind: "ui", type: "input", value: "" })
    };
    const response = await runtime.execute({
      kind: "invocation",
      method: "dev.feat",
      source: "code",
      arguments: [{ name: "input", value: "implement T1" }]
    }, [], { ui });
    expect(response.result).toMatchObject({ kind: "agent", text: "validated changes" });
    expect(agentInputs).toEqual(["implement T1", "context summary", "confirmed implementation plan", "implemented changes"]);
    expect(confirmations).toEqual(["confirmed implementation plan", "implemented changes"]);
  });

  it("executes MCP before the dev.feat context phase when configured", async () => {
    const apiRoot = join(process.cwd(), ".dext", "api");
    const entries = await readdir(apiRoot, { recursive: true, withFileTypes: true });
    const paths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".dx"))
      .map((entry) => join(entry.parentPath, entry.name));
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = await loadCustomApis(
      true,
      [apiRoot],
      async () => paths,
      async (path) => readFile(path, "utf8"),
      registry
    );
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setWorkspaceTrusted(true);
    runtime.setCustomPlans(loaded.plans);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    let mcpTool = "";
    let firstAgentInput = "";
    let agentCalls = 0;
    runtime.setMcpCaller(async (tool) => {
      mcpTool = tool;
      return { kind: "mcpRaw", server: "tasks", tool, content: "task from MCP" };
    });
    runtime.setAgentRunner({
      run: async (request) => {
        const input = request.resolved.arguments.input;
        if (!firstAgentInput && typeof input === "string") firstAgentInput = input;
        agentCalls += 1;
        return { kind: "agent", text: agentCalls === 1 ? "context" : "plan" };
      }
    });
    const ui: UiInteraction = {
        choose: async () => ({ kind: "ui", type: "choice", selected: [] as string[] }),
        confirm: async () => ({ kind: "ui", type: "confirm", confirmed: false }),
        input: async () => ({ kind: "ui", type: "input", value: "" })
    };
    await runtime.execute({
      kind: "invocation",
      method: "dev.feat",
      source: "code",
      arguments: [
        { name: "input", value: "ignored local input" },
        { name: "mcp_tool", value: "tasks.read" },
        { name: "mcp_input", value: {} }
      ]
    }, [], { ui });
    expect(mcpTool).toBe("tasks.read");
    expect(firstAgentInput).toBe("task from MCP");
  });
});
