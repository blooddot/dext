import { describe, expect, it } from "vitest";
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

// A workspace defines its own multi-phase APIs; this fixture stands in for one
// so the tests never depend on API files living in this repository.
const workflowFiles = new Map([
  ["C:/workspace/.dext/api/workflow/feature.dx", `def main(input: str, mcp_tool: str = "", mcp_input: dict[str, object] = {}, apply: bool = True) -> AgentResult:
    if mcp_tool != "":
        source = mcp(tool=mcp_tool, input=mcp_input)
        context = agent(input=source.content, apply=False)
    else:
        context = agent(input=input, apply=False)
    plan = agent(input=context.text, apply=False)
    plan_confirmation = ui.confirm(
        message=plan.text,
        confirm_label="Implement",
        cancel_label="Keep the plan"
    )
    if plan_confirmation.confirmed == True:
        implementation = agent(input=plan.text, apply=apply)
        implementation_confirmation = ui.confirm(
            message=implementation.text,
            confirm_label="Validate",
            cancel_label="Keep the changes"
        )
        if implementation_confirmation.confirmed == True:
            final = agent(input=implementation.text, apply=False)
        else:
            final = implementation
    else:
        final = plan
    return final
`]
]);

async function loadWorkflow(registry: MethodRegistry) {
  return loadCustomApis(
    true,
    ["C:/workspace/.dext/api"],
    async () => [...workflowFiles.keys()],
    async (path) => workflowFiles.get(path),
    registry
  );
}

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

  it("namespaces a nested workspace API and keeps its original source", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = await loadWorkflow(registry);
    expect(loaded.diagnostics).toEqual([]);
    expect([...loaded.plans.keys()]).toEqual(["workflow.feature"]);
    expect(loaded.files.find((file) => file.id === "workflow.feature")?.source)
      .toContain("plan_confirmation = ui.confirm(");
  });

  it("orchestrates a multi-phase API directly through Agent and ui.confirm", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = await loadWorkflow(registry);
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
      method: "workflow.feature",
      source: "code",
      arguments: [{ name: "input", value: "implement T1" }]
    }, [], { ui });
    expect(response.result).toMatchObject({ kind: "agent", text: "validated changes" });
    expect(agentInputs).toEqual(["implement T1", "context summary", "confirmed implementation plan", "implemented changes"]);
    expect(confirmations).toEqual(["confirmed implementation plan", "implemented changes"]);
  });

  it("executes MCP before the first context phase when configured", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = await loadWorkflow(registry);
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
      method: "workflow.feature",
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
