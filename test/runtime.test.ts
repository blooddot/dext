import { describe, expect, it } from "vitest";
import { AxAdapter } from "../src/core/axAdapter.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { compileWorkflow } from "../src/core/workflow.js";
import { WorkflowRuntime } from "../src/core/workflowRuntime.js";
import { ExecutionCancelledError } from "../src/core/executionErrors.js";
import type { TerminalResult } from "../src/core/types.js";

const host: ContextHost = {
  selection: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  file: async (path) => ({ uri: `file:///${path}`, content: "export const y = 2;", version: 1 }),
  symbol: async () => undefined
};

function setup() {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const runtime = new DextRuntime(registry, new ContextResolver(host));
  return { registry, runtime, workflow: new WorkflowRuntime(runtime) };
}

describe("Dext workflow runtime", () => {
  it("executes composable typed results sequentially", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`analysis = chat(message="explain", context=[ref.selection])
edit = code.edit(target=[ref.selection], instruction=analysis.text)
review = code.review(target=edit.files, instruction=edit.summary)
`, registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.steps?.map((step) => step.state)).toEqual(["success", "success", "success"]);
    expect(result.executions.map((item) => item.result.kind)).toEqual(["chat", "edit", "review"]);
  });

  it("marks the unselected if branch as skipped", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`review = code.review(target=[ref.selection])
if review.status == "pass":
    code.apply(patch=edit.patch)
else:
    chat(message="review needs attention")
`, registry);
    expect(compiled.diagnostics.map((item) => item.message)).toContain("Unknown variable 'edit'.");

    const valid = compileWorkflow(`review = code.review(target=[ref.selection])
if review.status == "pass":
    chat(message="pass")
else:
    chat(message="attention")
`, registry);
    const result = await workflow.execute(valid.program!);
    expect(result.steps?.map((step) => step.state)).toEqual(["success", "skipped", "success"]);
  });

  it("builds Ax/JSON Schema contracts for fixed outputs", () => {
    const method = BUILTIN_METHODS.find((candidate) => candidate.id === "code.review")!;
    const contract = new AxAdapter().compile(method);
    expect(contract.outputJsonSchema).toMatchObject({ type: "object", properties: { status: expect.any(Object) } });
  });

  it("does not write files when applying a no-op deterministic patch", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`edit = code.edit(target=[ref.selection], instruction="format")
applied = code.apply(patch=edit.patch)
`, registry);
    const result = await workflow.execute(compiled.program!);
    expect(result.executions.at(-1)?.result).toMatchObject({ kind: "apply", status: "unchanged" });
  });

  it("composes terminal output fields and preserves failed exit results", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const terminalResult: TerminalResult = {
      kind: "terminal",
      status: "failed",
      command: "exit 7",
      cwd: ".",
      exit_code: 7,
      stdout: "",
      stderr: "failed",
      duration_ms: 3
    };
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: () => terminalResult
    });
    const workflow = new WorkflowRuntime(runtime);
    const compiled = compileWorkflow(`terminal_result = terminal.run(command="exit 7")
chat(message=terminal_result.stderr)
`, registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.steps?.map((step) => step.state)).toEqual(["success", "success"]);
    expect(result.executions[0]?.result).toEqual(terminalResult);
  });

  it("marks rejected terminal confirmation as cancelled and skips downstream steps", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: () => { throw new ExecutionCancelledError("cancelled"); }
    });
    const compiled = compileWorkflow(`terminal.run(command="echo no")
chat(message="must not run")
`, registry);
    const result = await new WorkflowRuntime(runtime).execute(compiled.program!);
    expect(result.steps).toEqual([
      expect.objectContaining({ method: "terminal.run", state: "cancelled" }),
      expect.objectContaining({ method: "chat", state: "skipped" })
    ]);
  });

  it("builds the fixed terminal result contract", () => {
    const method = BUILTIN_METHODS.find((candidate) => candidate.id === "terminal.run")!;
    const contract = new AxAdapter().compile(method);
    expect(contract.inputJsonSchema).toMatchObject({
      properties: { command: { type: "string" }, cwd: { default: "." } }
    });
    expect(contract.outputJsonSchema).toMatchObject({
      properties: { status: { enum: ["succeeded", "failed", "timed_out"] } }
    });
  });

  it("returns a strict typed print result and composes its text", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`printed = print(text="hello", label="Build")
chat(message=printed.text)`, registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.executions[0]?.result).toEqual({ kind: "print", text: "hello", label: "Build" });
    const contract = new AxAdapter().compile(BUILTIN_METHODS.find((method) => method.id === "print")!);
    expect(contract.outputJsonSchema).toMatchObject({
      additionalProperties: false,
      properties: { label: { type: "string" } }
    });
  });
});
