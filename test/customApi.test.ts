import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { loadCustomApis } from "../src/core/customApi.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { AxAdapter } from "../src/core/axAdapter.js";
import { ExecutionCancelledError } from "../src/core/executionErrors.js";
import type { UiInteraction } from "../src/core/types.js";

const files = new Map([
  ["C:/workspace/.dext/api/team/explain.dx", `def main(input: str) -> ChatResult:\n    return ask(input=input)\n`],
  ["C:/workspace/.dext/api/team/review.dx", `import team.explain as describe\n\ndef main(input: str) -> ChatResult:\n    return describe(input=input)\n`],
  ["C:/workspace/.dext/api/team/namespace.dx", `import team\n\ndef main(input: str) -> ChatResult:\n    return team.explain(input=input)\n`]
]);

// A workspace defines its own multi-phase APIs; this fixture stands in for one
// so the tests never depend on API files living in this repository.
const workflowFiles = new Map([
  ["C:/workspace/.dext/api/workflow/feature.dx", `def main(input: str, apply: bool = True) -> AgentResult:
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
  async function loadSources(sources: Record<string, string>) {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const root = "C:/workspace/.dext/api";
    const contents = new Map(Object.entries(sources).map(([name, source]) => [`${root}/${name}.dx`, source]));
    const loaded = await loadCustomApis(true, [root], async () => [...contents.keys()], async (path) => contents.get(path), registry);
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setCustomPlans(loaded.plans);
    const execute = (method: string, args: Record<string, string | boolean> = {}) => runtime.execute({
      kind: "invocation", method, source: "code",
      arguments: Object.entries(args).map(([name, value]) => ({ name, value }))
    });
    return { registry, loaded, runtime, execute };
  }

  it("imports a sibling API's main using from namespace import name", async () => {
    const { loaded, execute } = await loadSources({
      "playground/verify": 'def main() -> PrintResult:\n    return print(text="verified")',
      "playground/develop": 'from playground import verify\n\ndef main() -> PrintResult:\n    return verify()'
    });
    expect(loaded.diagnostics).toEqual([]);
    expect((await execute("playground.develop")).result).toMatchObject({ text: "verified" });
  });

  it("runs helpers before and after main with defaults, typed results and isolated scopes", async () => {
    const { loaded, registry, execute } = await loadSources({
      develop: `def summarize(value: ChatResult, label: str = "summary") -> PrintResult:
    return print(text=value.text, label=label)

def main(input: str) -> PrintResult:
    value = ask(input=input)
    first = analyze(input="first")
    second = analyze(input="second")
    return summarize(value=value)

def analyze(input: str) -> PrintResult:
    value = ask(input=input)
    return summarize(value=value)
`
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(registry.get("summarize")).toBeUndefined();
    expect(loaded.methods.map((method) => method.definition.id)).toEqual(["develop"]);
    expect((await execute("develop", { input: "original" })).result).toMatchObject({ text: "original", label: "summary" });
  });

  it("runs private helpers through fan-out and nested calls", async () => {
    const { loaded, execute } = await loadSources({
      develop: `def main() -> PrintResult:
    names = ["first", "second"]
    reports = [report(input=name) for name in names]
    return print(text=reports)

def report(input: str) -> PrintResult:
    return print(text=ask(input=input).text)
`
    });
    expect(loaded.diagnostics).toEqual([]);
    const response = await execute("develop");
    expect(JSON.parse((response.result as { text: string }).text)).toEqual([
      { kind: "print", text: "first" }, { kind: "print", text: "second" }
    ]);
  });

  it("returns from a helper's except block and still executes finally", async () => {
    const { loaded, execute } = await loadSources({
      develop: `def main() -> PrintResult:
    return recover()

def recover() -> PrintResult:
    try:
        proposal = agent(input="preview", apply=False)
        return print(text=proposal.patch.changes)
    except Exception as error:
        return print(text=error, label="recovered")
    finally:
        print(text="cleanup")
    return print(text="unreachable")
`
    });
    expect(loaded.diagnostics).toEqual([]);
    expect((await execute("develop")).result).toMatchObject({ label: "recovered" });
  });

  it("does not evaluate a skipped return when a function falls through", async () => {
    const { loaded, execute } = await loadSources({
      develop: `def main() -> PrintResult:
    return conditional(enabled=False)

def conditional(enabled: bool) -> PrintResult:
    if enabled == True:
        return print(text="must not run")
`
    });
    expect(loaded.diagnostics).toEqual([]);
    await expect(execute("develop")).rejects.toThrow("did not return a result on this path");
  });

  it("propagates cancellation from a helper through exception handlers", async () => {
    const { loaded, runtime } = await loadSources({
      develop: `def main() -> UiResult:
    try:
        return confirm()
    except Exception as error:
        return ui.input(label="must not recover")

def confirm() -> UiResult:
    try:
        return ui.confirm(message="Proceed?")
    except Exception as error:
        return ui.input(label="must not recover")
    finally:
        ui.input(label="must not run after cancellation")
`
    });
    expect(loaded.diagnostics).toEqual([]);
    const prompts: string[] = [];
    const ui: UiInteraction = {
      choose: async () => ({ kind: "ui", type: "choice", selected: [] }),
      confirm: async () => { throw new ExecutionCancelledError("Cancelled by user"); },
      input: async ({ label }) => {
        prompts.push(label);
        return { kind: "ui", type: "input", value: "unexpected" };
      }
    };
    await expect(runtime.execute({ kind: "invocation", method: "develop", source: "code", arguments: [] }, [], { ui }))
      .rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(prompts).toEqual([]);
  });

  it("executes a finally return before completing a helper's exception return", async () => {
    const { loaded, execute } = await loadSources({
      develop: `def main() -> PrintResult:
    return recover()
def recover() -> PrintResult:
    try:
        proposal = agent(input="preview", apply=False)
        return print(text=proposal.patch.changes)
    except Exception as error:
        return print(text=error)
    finally:
        return print(text="finalized")
`
    });
    expect(loaded.diagnostics).toEqual([]);
    expect((await execute("develop")).result).toMatchObject({ text: "finalized" });
  });

  it("preserves helper errors for the caller's exception handler", async () => {
    const { loaded, execute } = await loadSources({
      develop: `def main() -> PrintResult:
    try:
        return inspect()
    except Exception as error:
        return print(text=error)

def inspect() -> PrintResult:
    proposal = agent(input="preview", apply=False)
    return print(text=proposal.patch.changes)
`
    });
    expect(loaded.diagnostics).toEqual([]);
    expect((await execute("develop")).result).toMatchObject({ text: "Result field 'patch' is unavailable." });
  });

  it.each([
    ['def helper() -> PrintResult:\n    return helper()', "Recursive local function"],
    ['def helper() -> PrintResult:\n    return other()\ndef other() -> PrintResult:\n    return helper()', "Recursive local function"],
    ['def helper() -> PrintResult:\n    return ask(input="wrong")', "helper() must return print result"],
    ['def helper() -> PrintResult:\n    return print(text=secret)', "Unknown variable"],
    ['def helper() -> PrintResult:\n    return print(text="one")\ndef helper() -> PrintResult:\n    return print(text="two")', "Duplicate function"],
    ['def helper() -> PrintResult:\n    return print(text="ok")\ndef ask() -> PrintResult:\n    return print(text="shadow")', "conflicts with an API"],
    ['def helper(input) -> PrintResult:\n    return print(text=input)', "requires a type annotation"]
  ])("rejects invalid helper definitions: %s", async (helper, diagnostic) => {
    const { loaded } = await loadSources({ develop: `def main() -> PrintResult:\n    secret = "private"\n    return helper()\n\n${helper}` });
    expect(loaded.diagnostics.join(" ")).toContain(diagnostic);
    expect(loaded.plans.has("develop")).toBe(false);
  });

  it("does not leak helpers into other files or overwrite helpers with the same name", async () => {
    const { loaded, execute } = await loadSources({
      first: 'def main() -> PrintResult:\n    return report()\ndef report() -> PrintResult:\n    return print(text="first")',
      second: 'def main() -> PrintResult:\n    return report()\ndef report() -> PrintResult:\n    return print(text="second")',
      third: 'def main() -> PrintResult:\n    return report()'
    });
    expect(loaded.diagnostics.join(" ")).toContain("Unknown Dext API 'report'");
    expect((await execute("first")).result).toMatchObject({ text: "first" });
    expect((await execute("second")).result).toMatchObject({ text: "second" });
  });

  it("rejects wrong concrete result parameters", async () => {
    const { loaded } = await loadSources({
      develop: `def main() -> PrintResult:
    wrong = print(text="wrong")
    return summarize(value=wrong)
def summarize(value: AgentResult) -> PrintResult:
    return print(text=value.text)
`
    });
    expect(loaded.diagnostics.length).toBeGreaterThan(0);
    expect(loaded.plans.size).toBe(0);
  });

  it("rejects cycles that pass through a private helper and another API", async () => {
    const { loaded } = await loadSources({
      "team/first": 'from team import second\ndef main() -> PrintResult:\n    return helper()\ndef helper() -> PrintResult:\n    return second()',
      "team/second": 'from team import first\ndef main() -> PrintResult:\n    return first()'
    });
    expect(loaded.diagnostics.join(" ")).toContain("Circular custom API call");
    expect(loaded.plans.size).toBe(0);
  });

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

  it("names an API by its path below the directory it was found in", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const shared = new Map([
      ["D:/shared/dext-apis/team/explain.dx", `def main(input: str) -> ChatResult:\n    return ask(input=input)\n`],
      ["D:/shared/dext-apis/audit.dx", `def main(input: str) -> ChatResult:\n    return ask(input=input)\n`]
    ]);
    const result = await loadCustomApis(
      true,
      ["D:/shared/dext-apis"],
      async () => [...shared.keys()],
      async (path) => shared.get(path),
      registry
    );
    expect(result.diagnostics).toEqual([]);
    // A configured directory produces the same names the workspace's own
    // .dext/api would, rather than a name built from the whole disk path.
    expect(registry.get("team.explain")).toBeDefined();
    expect(registry.get("audit")).toBeDefined();
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

});
