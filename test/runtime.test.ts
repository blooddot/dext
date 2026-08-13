import { describe, expect, it } from "vitest";
import { AxAdapter } from "../src/core/axAdapter.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { compileWorkflow } from "../src/core/workflow.js";
import { WorkflowRuntime } from "../src/core/workflowRuntime.js";
import { ExecutionCancelledError } from "../src/core/executionErrors.js";
import type { PatchResult, TerminalResult } from "../src/core/types.js";

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
    code.apply(result=edit)
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
    const explain = new AxAdapter().compile(BUILTIN_METHODS.find((candidate) => candidate.id === "code.explain")!);
    expect(explain.outputJsonSchema).toMatchObject({
      properties: { files: { type: "array", items: { type: "object" } } }
    });
  });

  it("does not write files when applying a no-op deterministic patch", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`edit = code.edit(target=[ref.selection], instruction="format")
applied = code.apply(result=edit)
`, registry);
    const result = await workflow.execute(compiled.program!);
    expect(result.executions.at(-1)?.result).toMatchObject({ kind: "apply", status: "unchanged" });
  });

  it("serializes non-code results as explain/review context", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`chat_result = chat(message="hello")
review_result = code.review(target=chat_result)
explain_result = code.explain(target=review_result)
`, registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.steps?.map((step) => step.state)).toEqual(["success", "success", "success"]);
    expect(result.executions.at(-1)?.result).toMatchObject({ kind: "explain", files: [{ uri: "dext-result://review/0" }] });
  });

  it("accepts an EditResult itself when applying its nested patch", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`edit_result = code.edit(target=ref.selection, instruction="format")
applied = code.apply(result=edit_result)
`, registry);
    expect(compiled.diagnostics).toEqual([]);
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
      expect.objectContaining({ method: "terminal.run", state: "cancelled", error: "cancelled" }),
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

  it("routes selected API calls through the configured agent runner", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setAgentProfiles([{
      id: "test-agent",
      label: "Test Agent",
      provider: "codex",
      command: "test-agent",
      models: ["test-model"]
    }]);
    runtime.setAgentSelection({ profileId: "test-agent", model: "test-model" });
    let receivedModel: string | undefined;
    runtime.setAgentRunner({
      run: async (request) => {
        receivedModel = request.model;
        return { kind: "chat", text: "agent response" };
      }
    });
    const response = await runtime.execute({
      kind: "invocation",
      method: "chat",
      source: "code",
      arguments: [{ name: "message", value: "hello" }]
    });
    expect(receivedModel).toBe("test-model");
    expect(response.result).toEqual({ kind: "chat", text: "agent response" });
  });

  it("maps isolated Agent edit previews back to the original code reference", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setAgentProfiles([{
      id: "test-agent",
      label: "Test Agent",
      provider: "codex",
      command: "test-agent",
      models: ["test-model"]
    }]);
    runtime.setAgentSelection({ profileId: "test-agent" });
    runtime.setAgentRunner({
      run: async () => ({
        kind: "edit",
        summary: "Preview",
        patch: {
          kind: "patch",
          title: "Edit",
          changes: [{ uri: "target-1/x.ts", before: "const x = 1;", after: "const x = 2;" }]
        },
        files: []
      })
    });

    const response = await runtime.execute({
      kind: "invocation",
      method: "code.edit",
      source: "code",
      arguments: [
        { name: "target", value: { kind: "selection" } },
        { name: "instruction", value: "increment" }
      ]
    });
    expect(response.result).toMatchObject({
      kind: "edit",
      files: [{ uri: "file:///x.ts", documentVersion: 1 }],
      patch: {
        changes: [{
          uri: "file:///x.ts",
          before: "const x = 1;",
          after: "const x = 2;",
          documentVersion: 1
        }]
      }
    });
  });

  it("keeps terminal.run local when an Agent CLI is selected", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const terminalResult: TerminalResult = {
      kind: "terminal",
      status: "succeeded",
      command: "echo local",
      cwd: ".",
      exit_code: 0,
      stdout: "local",
      stderr: "",
      duration_ms: 1
    };
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: () => terminalResult
    });
    runtime.setAgentProfiles([{
      id: "test-agent",
      label: "Test Agent",
      provider: "codex",
      command: "test-agent",
      models: ["test-model"]
    }]);
    runtime.setAgentSelection({ profileId: "test-agent", model: "test-model" });
    runtime.setAgentRunner({
      run: async () => { throw new Error("terminal.run must not invoke the Agent CLI"); }
    });

    const response = await runtime.execute({
      kind: "invocation",
      method: "terminal.run",
      source: "code",
      arguments: [{ name: "command", value: "echo local" }]
    });
    expect(response.result).toEqual(terminalResult);
  });

  it("keeps apply and print local when an Agent CLI is selected", async () => {
    const { runtime } = setup();
    runtime.setAgentProfiles([{
      id: "test-agent",
      label: "Test Agent",
      provider: "codex",
      command: "test-agent",
      models: ["test-model"]
    }]);
    runtime.setAgentSelection({ profileId: "test-agent", model: "test-model" });
    runtime.setAgentRunner({
      run: async () => { throw new Error("local APIs must not invoke the Agent CLI"); }
    });

    const printed = await runtime.execute({
      kind: "invocation",
      method: "print",
      source: "code",
      arguments: [{ name: "text", value: "local" }]
    });
    expect(printed.result).toEqual({ kind: "print", text: "local" });

    const applied = await runtime.execute({
      kind: "invocation",
      method: "code.apply",
      source: "code",
      arguments: [{
        name: "result",
        value: { kind: "patch", title: "No changes", changes: [] } as PatchResult
      }]
    });
    expect(applied.result).toMatchObject({ kind: "apply", status: "unchanged" });
  });
});
