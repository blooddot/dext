import { describe, expect, it } from "vitest";
import { AxAdapter } from "../src/core/axAdapter.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { compileWorkflow } from "../src/core/workflow.js";
import { WorkflowRuntime } from "../src/core/workflowRuntime.js";
import { fileReferenceInsertion } from "../src/webview/inputInsertion.js";
import { ExecutionCancelledError } from "../src/core/executionErrors.js";
import type { AgentResult, PatchResult, TerminalResult } from "../src/core/types.js";

const host: ContextHost = {
  selection: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  activeFile: async () => ({ uri: "file:///x.ts", content: "const x = 1;", version: 1 }),
  file: async (path) => ({ uri: `file:///${path}`, content: "export const y = 2;", version: 1 }),
  symbol: async () => undefined,
  dir: async (path) => ({ kind: "dirRef", uri: `file:///${path}`, path })
};

function setup() {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
    terminalRun: async ({ arguments: args }) => ({
      kind: "terminal",
      status: "succeeded",
      command: typeof args.command === "string" ? args.command : "",
      cwd: ".",
      exit_code: 0,
      stdout: "",
      stderr: "",
      duration_ms: 0
    })
  });
  return { registry, runtime, workflow: new WorkflowRuntime(runtime) };
}

describe("Dext workflow runtime", () => {
  it("executes ask, agent and print in sequence", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`answer = ask(input=f"Explain {ref.selection}")
task = agent(input="Plan this change", apply=False)
print(text=answer.text)`, registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.executions.map((item) => item.method.id)).toEqual(["ask", "agent", "print"]);
    expect(result.executions.map((item) => item.result.kind)).toEqual(["chat", "agent", "print"]);
  });

  it("builds strict contracts for public builtins", () => {
    const { registry } = setup();
    const ask = new AxAdapter().compile(registry.get("ask")!);
    expect(ask.inputSchema.safeParse({ input: "hello" }).success).toBe(true);
    expect(ask.inputSchema.safeParse({ message: "hello" }).success).toBe(false);
    const agent = new AxAdapter().compile(registry.get("agent")!);
    expect(agent.outputSchema.safeParse({ kind: "agent", text: "done" }).success).toBe(true);
    expect(registry.get("chat")).toBeUndefined();
    expect(registry.get("code.edit")).toBeUndefined();
    const mcp = new AxAdapter().compile(registry.get("mcp")!);
    expect(mcp.inputSchema.safeParse({ tool: "docs.read", input: { uri: "README.md" } }).success).toBe(true);
    expect(mcp.inputSchema.safeParse({ tool: "docs.read", input: "{}" }).success).toBe(false);
  });

  it("keeps apply and terminal local when an Agent is selected", async () => {
    const { runtime } = setup();
    let invoked = false;
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentRunner({ run: async () => { invoked = true; return { kind: "chat", text: "agent" }; } });
    await expect(runtime.execute({ kind: "invocation", method: "terminal", source: "code", arguments: [{ name: "command", value: "echo test" }] }))
      .resolves.toMatchObject({ result: { kind: "terminal" } });
    expect(invoked).toBe(false);
  });

  it("routes ask through the selected Agent runner", async () => {
    const { runtime } = setup();
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentRunner({ run: async () => ({ kind: "chat", text: "agent response" }) });
    await expect(runtime.execute({ kind: "invocation", method: "ask", source: "code", arguments: [{ name: "input", value: "hello" }] }))
      .resolves.toMatchObject({ result: { kind: "chat", text: "agent response" } });
  });

  it("composes failed terminal fields and preserves the complete result", async () => {
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
    const compiled = compileWorkflow(`terminal_result = terminal(command="exit 7")
printed = print(text=terminal_result.stderr)`, registry);

    expect(compiled.diagnostics).toEqual([]);
    const result = await new WorkflowRuntime(runtime).execute(compiled.program!);
    expect(result.steps?.map((step) => step.state)).toEqual(["success", "success"]);
    expect(result.executions[0]?.result).toEqual(terminalResult);
    expect(result.executions[1]?.result).toEqual({ kind: "print", text: "failed" });
  });

  it("marks the unselected terminal status branch as skipped", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`terminal_result = terminal(command="echo ok")
if terminal_result.status == "succeeded":
    print(text="success")
else:
    print(text="failure")`, registry);

    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.steps?.map((step) => step.state)).toEqual(["success", "skipped", "success"]);
  });

  it("marks a cancelled terminal confirmation and skips later calls", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: () => { throw new ExecutionCancelledError("cancelled"); }
    });
    const compiled = compileWorkflow(`terminal(command="echo no")
print(text="must not run")`, registry);
    const result = await new WorkflowRuntime(runtime).execute(compiled.program!);

    expect(result.steps).toEqual([
      expect.objectContaining({ method: "terminal", state: "cancelled", error: "cancelled" }),
      expect.objectContaining({ method: "print", state: "skipped" })
    ]);
  });

  it("keeps terminal and print contracts strict and composable", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`printed = print(text="hello", label="Build")
answer = ask(input=printed.text)`, registry);

    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.executions[0]?.result).toEqual({ kind: "print", text: "hello", label: "Build" });
    expect(result.executions[1]?.result).toEqual({ kind: "chat", text: "hello" });
    const terminal = new AxAdapter().compile(registry.get("terminal")!);
    expect(terminal.outputJsonSchema).toMatchObject({
      properties: { status: { enum: ["succeeded", "failed", "timed_out"] } }
    });
    const printed = new AxAdapter().compile(registry.get("print")!);
    expect(printed.outputJsonSchema).toMatchObject({
      additionalProperties: false,
      properties: { label: { type: "string" } }
    });
  });

  it("accepts an AgentResult patch directly in apply", async () => {
    const { runtime } = setup();
    const patch: PatchResult = { kind: "patch", title: "No changes", changes: [] };
    const agentResult: AgentResult = { kind: "agent", text: "preview", patch };

    await expect(runtime.execute({
      kind: "invocation",
      method: "apply",
      source: "code",
      arguments: [{ name: "result", value: agentResult }]
    })).resolves.toMatchObject({ result: { kind: "apply", status: "unchanged" } });
  });

  it("keeps agent previews read-only and gates workspace writes on trust", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: ["gpt-test"] }]);
    runtime.setAgentSelection({ profileId: "codex", model: "gpt-test" });
    const requests: { allowWorkspaceWrite: boolean | undefined; cwd: string }[] = [];
    runtime.setAgentRunner({
      run: async (request) => {
        requests.push({ allowWorkspaceWrite: request.allowWorkspaceWrite, cwd: request.cwd });
        return { kind: "agent", text: "done" };
      }
    });

    await expect(runtime.execute({
      kind: "invocation", method: "agent", source: "code",
      arguments: [{ name: "input", value: "preview" }, { name: "apply", value: false }]
    })).resolves.toMatchObject({ result: { kind: "agent", text: "done" } });
    expect(requests).toEqual([{ allowWorkspaceWrite: false, cwd: process.cwd() }]);

    await expect(runtime.execute({
      kind: "invocation", method: "agent", source: "code", arguments: [{ name: "input", value: "write" }]
    })).rejects.toThrow("trusted local workspace");
    expect(requests).toHaveLength(1);

    runtime.setWorkspaceTrusted(true);
    await runtime.execute({
      kind: "invocation", method: "agent", source: "code", arguments: [{ name: "input", value: "write" }]
    });
    expect(requests[1]).toEqual({ allowWorkspaceWrite: true, cwd: process.cwd() });
  });

  it("preserves readable @ tokens without resolving file content", async () => {
    const resolved: string[] = [];
    const orderedHost: ContextHost = {
      selection: async () => {
        resolved.push("selection");
        return { uri: "file:///selection.ts", content: "selection", version: 1 };
      },
      activeFile: async () => undefined,
      file: async (path) => {
        resolved.push(`file:${path}`);
        return { uri: `file:///${path}`, content: path, version: 1 };
      },
      symbol: async () => undefined,
      dir: async () => undefined
    };
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const workflow = new WorkflowRuntime(new DextRuntime(registry, new ContextResolver(orderedHost)));
    const compiled = compileWorkflow('answer = ask(input="A @first.ts B @selection C")', registry);

    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    const text = (result.executions[0]?.result as { text?: string }).text ?? "";
    expect(resolved).toEqual([]);
    expect(text).toBe("A @first.ts B @selection C");
  });

  it("compiles and resolves the exact serialized agent file-drop input", async () => {
    const { registry, workflow } = setup();
    const initial = 'agent(input="这段代码是什么含义")';
    const edit = fileReferenceInsertion(initial, 0, 0, ['@src/pathx.py#L55,1-L66,32']);
    const source = `${initial.slice(0, edit.from)}${edit.text}${initial.slice(edit.to)}`;

    expect(source).toMatch(/^agent\(input="这段代码是什么含义 /);
    expect(source).not.toContain('f"');
    expect(source).not.toContain("ref.file(");
    const compiled = compileWorkflow(source, registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect((result.executions[0]?.result as { text?: string }).text)
      .toBe("这段代码是什么含义 @src/pathx.py#L55,1-L66,32");
  });

  it("forwards the selected model and rejects invalid Agent output", async () => {
    const { runtime } = setup();
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: ["gpt-test"] }]);
    runtime.setAgentSelection({ profileId: "codex", model: "gpt-test" });
    const models: (string | undefined)[] = [];
    runtime.setAgentRunner({
      run: async (request) => {
        models.push(request.model);
        return request.method.id === "ask"
          ? { kind: "chat", text: "valid" }
          : { kind: "agent", text: "invalid", extra: true };
      }
    });

    await expect(runtime.execute({
      kind: "invocation", method: "ask", source: "code", arguments: [{ name: "input", value: "hello" }]
    })).resolves.toMatchObject({ result: { kind: "chat", text: "valid" } });
    await expect(runtime.execute({
      kind: "invocation", method: "agent", source: "code",
      arguments: [{ name: "input", value: "preview" }, { name: "apply", value: false }]
    })).rejects.toThrow();
    expect(models).toEqual(["gpt-test", "gpt-test"]);
  });

  it("keeps terminal, apply, and print local when an Agent is selected", async () => {
    const { runtime } = setup();
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentRunner({ run: async () => { throw new Error("local APIs must not invoke the Agent runner"); } });

    await expect(runtime.execute({
      kind: "invocation", method: "terminal", source: "code", arguments: [{ name: "command", value: "echo local" }]
    })).resolves.toMatchObject({ result: { kind: "terminal" } });
    await expect(runtime.execute({
      kind: "invocation", method: "print", source: "code", arguments: [{ name: "text", value: "local" }]
    })).resolves.toMatchObject({ result: { kind: "print", text: "local" } });
    await expect(runtime.execute({
      kind: "invocation", method: "apply", source: "code", arguments: [{
        name: "result", value: { kind: "patch", title: "No changes", changes: [] } as PatchResult
      }]
    })).resolves.toMatchObject({ result: { kind: "apply", status: "unchanged" } });
  });

  it("passes typed nested MCP input and resolved scalar references to the configured caller", async () => {
    const { registry, runtime, workflow } = setup();
    runtime.setWorkspaceTrusted(true);
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    runtime.setMcpCaller(async (tool, input) => {
      calls.push({ tool, input });
      return { kind: "mcpRaw", server: "docs", tool: "read" };
    });
    const compiled = compileWorkflow(`result = mcp(
    tool="docs.read",
    input={"meta": {"labels": ["guide", "api"]}, "file": "@README.md"}
)`, registry);

    expect(compiled.diagnostics).toEqual([]);
    await workflow.execute(compiled.program!);
    expect(calls).toEqual([{
      tool: "docs.read",
      input: {
        meta: { labels: ["guide", "api"] },
        file: expect.objectContaining({ kind: "codeRef", uri: "file:///README.md", content: "export const y = 2;" })
      }
    }]);
  });

  it("requires a trusted local workspace before invoking an MCP caller", async () => {
    const { runtime } = setup();
    runtime.setMcpCaller(async () => ({ kind: "mcpRaw", server: "docs", tool: "read" }));

    await expect(runtime.execute({
      kind: "invocation",
      method: "mcp",
      source: "code",
      arguments: [{ name: "tool", value: "docs.read" }, { name: "input", value: {} }]
    })).rejects.toThrow("trusted local workspace");
  });
});
