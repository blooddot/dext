import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxAdapter } from "../src/core/axAdapter.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { compileWorkflow } from "../src/core/workflow.js";
import { WorkflowRuntime } from "../src/core/workflowRuntime.js";
import { parseMcpManifest } from "../src/core/mcpManifest.js";
import { fileReferenceInsertion } from "../src/webview/inputInsertion.js";
import { ExecutionCancelledError } from "../src/core/executionErrors.js";
import type { AgentConversationRequest } from "../src/core/agentRunner.js";
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
  it("limits node.fs to a trusted workspace and rejects traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-node-"));
    try {
      const { runtime } = setup();
      runtime.setWorkspaceRoot(root);
      runtime.setWorkspaceTrusted(true);
      await runtime.execute({ kind: "invocation", method: "node.fs.writeFile", source: "code", arguments: [{ name: "path", value: "state.txt" }, { name: "content", value: "ok" }] });
      expect(await readFile(join(root, "state.txt"), "utf8")).toBe("ok");
      await expect(runtime.execute({ kind: "invocation", method: "node.fs.readFile", source: "code", arguments: [{ name: "path", value: "../outside.txt" }] }))
        .rejects.toThrow("workspace");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses node.http.request for bounded, serializable local HTTP responses", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end(`${request.method}:${request.url}`);
    });
    await new Promise<void>((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server.");
      const { runtime } = setup();
      runtime.setWorkspaceTrusted(true);
      const response = await runtime.execute({ kind: "invocation", method: "node.http.request", source: "code", arguments: [{ name: "url", value: `http://127.0.0.1:${address.port}/health` }] });
      expect(response.result).toMatchObject({ kind: "node", status: 200, body: "GET:/health" });
    } finally { await new Promise<void>((resolveServer, rejectServer) => server.close((error) => error ? rejectServer(error) : resolveServer())); }
  });
  it("passes terminal environment variables through the generic terminal API", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    let received: Record<string, unknown> | undefined;
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => {
        received = args as Record<string, unknown>;
        return { kind: "terminal", status: "succeeded", command: typeof args.command === "string" ? args.command : "", cwd: ".", exit_code: 0, stdout: "", stderr: "", duration_ms: 0 };
      }
    });
    await runtime.execute({
      kind: "invocation",
      method: "terminal",
      source: "code",
      arguments: [
        { name: "command", value: "tool run" },
        { name: "env", value: { TASK_TITLE: "Login fails" } }
      ]
    });
    expect(received).toMatchObject({ command: "tool run", env: { TASK_TITLE: "Login fails" } });
  });

  it("extracts the final path segment with whitelisted Node URL and path APIs", async () => {
    const { runtime } = setup();
    const parsed = await runtime.execute({
      kind: "invocation",
      method: "node.url.parse",
      source: "code",
      arguments: [{ name: "url", value: "https://www.teambition.com/task/6a9c21511d7b3a0050e59a0e?from=notice" }]
    });
    const response = await runtime.execute({
      kind: "invocation", method: "node.path.basename", source: "code",
      arguments: [{ name: "path", value: (parsed.result as unknown as { pathname: string }).pathname }]
    });
    expect(response.result).toEqual({ kind: "node", value: "6a9c21511d7b3a0050e59a0e" });
  });


  it("keeps Harness Ask and plan generation read-only while permitting explicit execution", async () => {
    const { runtime } = setup();
    const requests: AgentConversationRequest[] = [];
    runtime.setAgentProfiles([{ id: "deepseek-harness", provider: "deepseek-harness", command: "dsh", label: "Harness", models: [] }]);
    runtime.setAgentSelection({ profileId: "deepseek-harness", permission: "full-access" });
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentRunner({ run: async () => ({ kind: "ask", text: "typed" }), runConversation: async (request) => { requests.push(request); return "answer"; } });
    await runtime.executeConversation("ask", "explain");
    await runtime.executeConversation("plan", "plan it");
    await runtime.executeConversation("plan", "build it", { executePlan: true });
    await runtime.executeConversation("agent", "implement");
    expect(requests.map((item) => item.permission)).toEqual(["read-only", "read-only", "full-access", "full-access"]);
    expect(requests[1]?.input).toContain("dext-plan:start");
    expect(requests[2]?.input).toBe("build it");
  });
  it("accepts JSON object content for typed MCP results when structuredContent is omitted", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = parseMcpManifest(JSON.stringify({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{
        name: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { code: { type: "integer" } } }
      }]
    }), "team.jsonc");
    registry.registerMany(loaded.methods, "project");
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setWorkspaceTrusted(true);
    runtime.setMcpCaller(async () => ({
      kind: "mcpRaw",
      server: "team",
      tool: "query",
      content: JSON.stringify({ code: 200 })
    }));
    const compiled = compileWorkflow("mcp.team.query()", registry);
    expect(compiled.diagnostics).toEqual([]);
    const execution = await new WorkflowRuntime(runtime).execute(compiled.program!);
    expect(execution.executions[0]?.result).toMatchObject({ kind: "mcp.team.query", code: 200 });
  });

  it("accepts JSON objects wrapped in an MCP server response prefix", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = parseMcpManifest(JSON.stringify({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{
        name: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { result: { type: "array" } } }
      }]
    }), "team.jsonc");
    registry.registerMany(loaded.methods, "project");
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setWorkspaceTrusted(true);
    runtime.setMcpCaller(async () => ({
      kind: "mcpRaw",
      server: "team",
      tool: "query",
      content: `API Response (Status: 200):\n${JSON.stringify({ result: [{ id: "t1" }] })}`
    }));
    const compiled = compileWorkflow("mcp.team.query()", registry);
    expect(compiled.diagnostics).toEqual([]);
    const execution = await new WorkflowRuntime(runtime).execute(compiled.program!);
    expect(execution.executions[0]?.result).toMatchObject({
      kind: "mcp.team.query",
      result: [{ id: "t1" }]
    });
  });

  it("does not expose the internal MCP kind when printing a typed result", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const loaded = parseMcpManifest(JSON.stringify({
      name: "team", transport: "stdio", command: "team-mcp",
      tools: [{ name: "query", inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { result: { type: "array" } } } }]
    }), "team.jsonc");
    registry.registerMany(loaded.methods, "project");
    const runtime = new DextRuntime(registry, new ContextResolver(host));
    runtime.setWorkspaceTrusted(true);
    runtime.setMcpCaller(async () => ({
      kind: "mcpRaw", server: "team", tool: "query",
      structured: { result: [{ id: "t1" }] }
    }));
    const compiled = compileWorkflow("result = mcp.team.query()\nprint(result)", registry);
    expect(compiled.diagnostics).toEqual([]);
    const execution = await new WorkflowRuntime(runtime).execute(compiled.program!);
    expect(execution.executions.at(-1)?.result).toMatchObject({
      kind: "print", text: '{"result":[{"id":"t1"}]}'
    });
  });

  it("executes ask, agent and print in sequence", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`answer = ask(input=f"Explain {ref.selection}")
task = agent(input="Plan this change", apply=False)
print(text=answer.text)`, registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(result.executions.map((item) => item.method.id)).toEqual(["ask", "agent", "print"]);
    expect(result.executions.map((item) => item.result.kind)).toEqual(["ask", "agent", "print"]);
  });

  it("returns immediately from a custom workflow branch", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow([
      'before = print(text="before")',
      'decision = ui.confirm(message="Continue?")',
      "if decision.confirmed != True:",
      "    return before",
      'after = print(text="after")',
      "return after"
    ].join("\n"), registry, { allowReturn: true });
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.executeValue(compiled.program!, [], {
      ui: {
        form: async () => ({ kind: "ui", type: "form", status: "cancelled", answers: {} })
      }
    });
    expect(result).toMatchObject({ kind: "print", text: "before" });
    const continued = await workflow.executeValue(compiled.program!, [], {
      ui: {
        form: async () => ({ kind: "ui", type: "form", status: "submitted", answers: {} })
      }
    });
    expect(continued).toMatchObject({ kind: "print", text: "after" });
  });

  it("runs a for loop once per item and drops the loop variable afterwards", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow([
      'commands = ["git status", "git diff"]',
      "for command in commands:",
      "    terminal(command=command)"
    ].join("\n"), registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    // A literal list is inlined at compile time, so the only steps are the two
    // passes through the body.
    expect(result.steps?.map((step) => step.state)).toEqual(["success", "success"]);
    // The body runs with the item bound, so each pass sees its own command.
    expect(result.executions.map((item) => item.result.kind === "terminal" ? item.result.command : ""))
      .toEqual(["git status", "git diff"]);
  });

  it("marks a loop body skipped when the list is empty and stops the workflow when a pass fails", async () => {
    const { registry, workflow } = setup();
    const empty = compileWorkflow([
      "items: list[str] = []",
      "for item in items:",
      "    terminal(command=item)"
    ].join("\n"), registry);
    expect(empty.diagnostics).toEqual([]);
    const emptyResult = await workflow.execute(empty.program!);
    expect(emptyResult.steps).toEqual([{ method: "terminal", state: "skipped" }]);

    const registry2 = new MethodRegistry();
    registry2.registerMany(BUILTIN_METHODS, "builtin");
    let calls = 0;
    const runtime = new DextRuntime(registry2, new ContextResolver(host), undefined, {
      terminalRun: () => {
        calls += 1;
        if (calls === 2) throw new Error("second command failed");
        return {
          kind: "terminal",
          status: "succeeded",
          command: "",
          cwd: ".",
          exit_code: 0,
          stdout: "",
          stderr: "",
          duration_ms: 0
        } satisfies TerminalResult;
      }
    });
    const failing = compileWorkflow([
      'commands = ["a", "b", "c"]',
      "for command in commands:",
      "    terminal(command=command)",
      'print(text="done")'
    ].join("\n"), registry2);
    expect(failing.diagnostics).toEqual([]);
    const failed = await new WorkflowRuntime(runtime).execute(failing.program!);
    // A failing pass stops the loop, and everything after it is reported skipped
    // rather than silently dropped.
    expect(failed.steps?.map((step) => `${step.method}:${step.state}`)).toEqual([
      "terminal:success",
      "terminal:failed",
      "print:skipped"
    ]);
    expect(calls).toBe(2);
  });

  it("fans a comprehension out concurrently, caps the width, and keeps list order", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    let inFlight = 0;
    let peak = 0;
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // The later items resolve sooner, so an implementation that appended
        // results as they settled would scramble the order.
        const command = typeof args.command === "string" ? args.command : "";
        await new Promise((resolve) => setTimeout(resolve, command === "a" ? 20 : 1));
        inFlight -= 1;
        return {
          kind: "terminal",
          status: "succeeded",
          command,
          cwd: ".",
          exit_code: 0,
          stdout: command,
          stderr: "",
          duration_ms: 0
        } satisfies TerminalResult;
      }
    });
    const workflow = new WorkflowRuntime(runtime);
    workflow.setMaxConcurrency(2);
    const compiled = compileWorkflow([
      'commands = ["a", "b", "c", "d"]',
      "runs = [terminal(command=command) for command in commands]"
    ].join("\n"), registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect(peak).toBe(2);
    // Each branch gets its own step, indexed by position, followed by the
    // assignment that binds the collected list.
    expect(result.steps?.map((step) => `${step.method}#${step.branch ?? "-"}:${step.state}`)).toEqual([
      "terminal#0:success",
      "terminal#1:success",
      "terminal#2:success",
      "terminal#3:success",
      "=#-:success"
    ]);
    expect(result.executions.map((item) => item.result.kind === "terminal" ? item.result.command : ""))
      .toEqual(["a", "b", "c", "d"]);
  });

  it("stops a fan-out on cancellation and reports the branch that failed", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const controller = new AbortController();
    let started = 0;
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => {
        started += 1;
        if (started === 1) controller.abort();
        const command = typeof args.command === "string" ? args.command : "";
        if (command === "b") throw new Error("branch b failed");
        return {
          kind: "terminal",
          status: "succeeded",
          command,
          cwd: ".",
          exit_code: 0,
          stdout: "",
          stderr: "",
          duration_ms: 0
        } satisfies TerminalResult;
      }
    });
    const cancelling = new WorkflowRuntime(runtime);
    cancelling.setMaxConcurrency(1);
    const compiled = compileWorkflow([
      'commands = ["a", "b", "c"]',
      "runs = [terminal(command=command) for command in commands]",
      'print(text="done")'
    ].join("\n"), registry);
    expect(compiled.diagnostics).toEqual([]);
    const cancelled = await cancelling.execute(compiled.program!, [], { signal: controller.signal });
    // Aborting stops handing out branches: the first one already in flight still
    // finishes, the second never starts, and the statement after the fan-out is
    // reported skipped rather than dropped.
    expect(started).toBe(1);
    expect(cancelled.steps?.map((step) => `${step.method}:${step.state}`)).toEqual([
      "terminal:success",
      "=:cancelled",
      "print:skipped"
    ]);

    const failing = new WorkflowRuntime(new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: async ({ arguments: args }) => {
        const command = typeof args.command === "string" ? args.command : "";
        if (command === "b") throw new Error("branch b failed");
        return {
          kind: "terminal",
          status: "succeeded",
          command,
          cwd: ".",
          exit_code: 0,
          stdout: "",
          stderr: "",
          duration_ms: 0
        } satisfies TerminalResult;
      }
    }));
    failing.setMaxConcurrency(1);
    const result = await failing.execute(compiled.program!);
    const failed = result.steps?.find((step) => step.state === "failed");
    expect(failed).toMatchObject({ method: "terminal", branch: 1 });
    expect(failed?.error).toContain("branch b failed");
    expect(result.steps?.at(-1)).toMatchObject({ method: "print", state: "skipped" });
  });

  it("hands a failing step to except instead of skipping the rest of the workflow", async () => {
    const registry = new MethodRegistry();
    registry.registerMany(BUILTIN_METHODS, "builtin");
    const runtime = new DextRuntime(registry, new ContextResolver(host), undefined, {
      terminalRun: () => {
        throw new Error("npm test exited 1");
      }
    });
    const compiled = compileWorkflow([
      "try:",
      '    checked = terminal(command="npm test")',
      "except Exception as failure:",
      "    print(text=failure)",
      "finally:",
      '    print(text="cleanup")',
      'print(text="still running")'
    ].join("\n"), registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await new WorkflowRuntime(runtime).execute(compiled.program!);
    expect(result.steps?.map((step) => `${step.method}:${step.state}`)).toEqual([
      "terminal:failed",
      "print:success",
      "print:success",
      "print:success"
    ]);
    // The handler sees the failure message, and the statement after the try runs
    // because the failure was handled.
    const handled = result.executions[0];
    expect(handled?.result.kind === "print" && handled.result.text).toContain("npm test exited 1");
  });

  it("runs finally on success, skips the handler, and lets cancellation pass through", async () => {
    const { registry, workflow } = setup();
    const passing = compileWorkflow([
      "try:",
      '    checked = terminal(command="npm test")',
      "except:",
      '    print(text="recovering")',
      "finally:",
      '    print(text="cleanup")'
    ].join("\n"), registry);
    expect(passing.diagnostics).toEqual([]);
    const result = await workflow.execute(passing.program!);
    expect(result.steps?.map((step) => `${step.method}:${step.state}`)).toEqual([
      "terminal:success",
      "print:skipped",
      "print:success"
    ]);

    const controller = new AbortController();
    const cancellingRegistry = new MethodRegistry();
    cancellingRegistry.registerMany(BUILTIN_METHODS, "builtin");
    const cancelling = new WorkflowRuntime(new DextRuntime(
      cancellingRegistry,
      new ContextResolver(host),
      undefined,
      {
        terminalRun: () => {
          controller.abort();
          throw new ExecutionCancelledError();
        }
      }
    ));
    const compiled = compileWorkflow([
      "try:",
      '    checked = terminal(command="npm test")',
      "except:",
      '    print(text="recovering")',
      "finally:",
      '    print(text="cleanup")'
    ].join("\n"), cancellingRegistry);
    const cancelled = await cancelling.execute(compiled.program!, [], { signal: controller.signal });
    // Stopping is the user's decision, so except does not get to override it and
    // neither the handler nor the finalizer runs.
    expect(cancelled.steps?.map((step) => `${step.method}:${step.state}`)).toEqual([
      "terminal:cancelled",
      "print:skipped",
      "print:skipped"
    ]);
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
  });

  it("keeps apply and terminal local when an Agent is selected", async () => {
    const { runtime } = setup();
    let invoked = false;
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentRunner({ run: async () => { invoked = true; return { kind: "ask", text: "agent" }; } });
    await expect(runtime.execute({ kind: "invocation", method: "terminal", source: "code", arguments: [{ name: "command", value: "echo test" }] }))
      .resolves.toMatchObject({ result: { kind: "terminal" } });
    expect(invoked).toBe(false);
  });

  it("routes ask through the selected Agent runner", async () => {
    const { runtime } = setup();
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentRunner({ run: async () => ({ kind: "ask", text: "agent response" }) });
    await expect(runtime.execute({ kind: "invocation", method: "ask", source: "code", arguments: [{ name: "input", value: "hello" }] }))
      .resolves.toMatchObject({ result: { kind: "ask", text: "agent response" } });
  });

  it("loads selected skills before ordered rules from .dext", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setSkillLoader(async (skill) => ({
      sourcePath: `${skill}/SKILL.md`,
      instructions: `skill ${skill}`
    }));
    runtime.setRuleLoader(async (path) => {
      if (path.endsWith("base.md")) return "base rule";
      if (path.endsWith("phase.md")) return "phase rule";
      return undefined;
    });
    let instruction = "";
    runtime.setAgentRunner({
      run: async (request) => {
        instruction = request.metadata.instruction ?? "";
        return { kind: "agent", text: "done" };
      }
    });

    await runtime.execute({
      kind: "invocation",
      method: "agent",
      source: "code",
      arguments: [
        { name: "input", value: "implement" },
        { name: "apply", value: false },
        { name: "skills", value: ["project", "testing", "project"] },
        { name: "rules", value: ["dev/base.md", "dev/phase.md"] }
      ]
    });

    expect(instruction).toBe([
      "Follow the skill 'project' from project/SKILL.md for this agent call.\n\nskill project",
      "Follow the skill 'testing' from testing/SKILL.md for this agent call.\n\nskill testing",
      "Apply rule 'dev/base.md':\n\nbase rule",
      "Apply rule 'dev/phase.md':\n\nphase rule"
    ].join("\n\n"));
    await expect(runtime.execute({
      kind: "invocation",
      method: "agent",
      source: "code",
      arguments: [
        { name: "input", value: "implement" },
        { name: "apply", value: false },
        { name: "rules", value: ["../api/dev/feat.dx"] }
      ]
    })).rejects.toThrow("rules must stay below .dext/rules");
  });

  it("runs Agent and Ask as ordinary provider conversations", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    const requests: { mode: string; input: string; permission?: string; allowWorkspaceWrite: boolean }[] = [];
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (request) => {
        requests.push(request);
        return `reply: ${request.input}`;
      }
    });

    await expect(runtime.executeConversation("agent", "Update this module"))
      .resolves.toMatchObject({ result: { kind: "agent", text: "reply: Update this module" } });
    await expect(runtime.executeConversation("ask", "Explain this module"))
      .resolves.toMatchObject({ result: { kind: "ask", text: "reply: Explain this module" } });
    expect(requests).toEqual([
      expect.objectContaining({ mode: "agent", input: "Update this module", allowWorkspaceWrite: true }),
      expect.objectContaining({ mode: "ask", input: "Explain this module", allowWorkspaceWrite: false })
    ]);
  });

  it("keeps a write tier on the conversation path and never lets a read-only mode escalate", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setRuleLoader(async () => undefined);
    const requests: { mode: string; permission?: string; allowWorkspaceWrite: boolean }[] = [];
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (request) => {
        requests.push(request);
        return "done";
      }
    });

    runtime.setAgentSelection({ profileId: "codex", permission: "full-access" });
    await runtime.executeConversation("agent", "Update this module");
    await runtime.executeConversation("ask", "Explain this module");
    await runtime.executeConversation("plan", "Add a cache");
    expect(requests).toEqual([
      expect.objectContaining({ mode: "agent", permission: "full-access", allowWorkspaceWrite: true }),
      // Ask is read-only; Plan uses the selected write tier.
      expect.objectContaining({ mode: "ask", permission: "read-only", allowWorkspaceWrite: false }),
      expect.objectContaining({ mode: "plan", permission: "full-access", allowWorkspaceWrite: true })
    ]);
  });

  it("passes provider CLI arguments through only from a trusted workspace", async () => {
    const { runtime } = setup();
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex", permission: "workspace-write" });
    runtime.setAgentCliArguments({ codex: ["--profile", "audit"], claude: ["--add-dir", "/tmp"] });
    const requests: { cliArguments?: readonly string[] }[] = [];
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (request) => {
        requests.push(request);
        return "done";
      }
    });

    runtime.setWorkspaceTrusted(false);
    await runtime.executeConversation("ask", "Explain this module");
    runtime.setWorkspaceTrusted(true);
    await runtime.executeConversation("agent", "Update this module");
    expect(requests[0]?.cliArguments).toBeUndefined();
    // Only the selected provider's arguments are forwarded.
    expect(requests[1]?.cliArguments).toEqual(["--profile", "audit"]);
  });

  it("falls back to the configured default permission until the composer chooses one", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setDefaultAgentPermission("full-access");
    let permission: string | undefined;
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (request) => {
        permission = request.permission;
        return "done";
      }
    });

    await runtime.executeConversation("agent", "Update this module");
    expect(permission).toBe("full-access");
    // An explicit choice always wins over the setting.
    runtime.setAgentSelection({ profileId: "codex", permission: "workspace-write" });
    await runtime.executeConversation("agent", "Update this module");
    expect(permission).toBe("workspace-write");
  });

  it("runs Plan with the selected write tier and prefixes the built-in planning instruction", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setRuleLoader(async () => undefined);
    const requests: { mode: string; input: string; permission?: string; allowWorkspaceWrite: boolean }[] = [];
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (request) => {
        requests.push(request);
        return "# Plan\n\n## Goal\nShip it.";
      }
    });

    await expect(runtime.executeConversation("plan", "Add a cache"))
      .resolves.toMatchObject({ method: { id: "plan" }, result: { kind: "plan" } });
    const request = requests[0]!;
    expect(request.allowWorkspaceWrite).toBe(true);
    expect(request.permission).toBe("workspace-write");
    expect(request.mode).toBe("plan");
    expect(request.input).toContain("You are in Dext Plan mode.");
    expect(request.input).toContain("Do not create, modify, or delete any file.");
    // The user's own words stay verbatim below the instruction.
    expect(request.input.endsWith("Goal:\n\nAdd a cache")).toBe(true);
  });

  it("executes a saved Plan in Plan mode with its selected write tier", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex", permission: "full-access" });
    let request: { mode: string; input: string; permission?: string; allowWorkspaceWrite: boolean } | undefined;
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (value) => {
        request = value;
        return "Implemented.";
      }
    });

    await runtime.executeConversation("plan", "Implement the saved plan", { executePlan: true });
    expect(request).toMatchObject({
      mode: "plan",
      input: "Implement the saved plan",
      permission: "full-access",
      allowWorkspaceWrite: true
    });
  });

  it("lets .dext/rules/plan.md replace the built-in Plan instruction", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceRoot("/workspace");
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    const requestedPaths: string[] = [];
    runtime.setRuleLoader(async (path) => {
      requestedPaths.push(path.replaceAll("\\", "/"));
      return "Project planning instruction.\n";
    });
    let sent = "";
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (request) => {
        sent = request.input;
        return "# Plan";
      }
    });

    await runtime.executeConversation("plan", "Add a cache");
    expect(requestedPaths).toEqual(["/workspace/.dext/rules/plan.md"]);
    expect(sent).toContain("Project planning instruction.");
    expect(sent).not.toContain("You are in Dext Plan mode.");
  });

  it("keeps the built-in Plan instruction when the workspace is untrusted", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceTrusted(false);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    let loaderCalls = 0;
    runtime.setRuleLoader(async () => {
      loaderCalls += 1;
      return "untrusted instruction";
    });
    let sent = "";
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (request) => {
        sent = request.input;
        return "# Plan";
      }
    });

    await expect(runtime.executeConversation("plan", "Add a cache")).rejects.toThrow("Plan mode requires a trusted local workspace");
    expect(loaderCalls).toBe(0);
    expect(sent).toBe("");
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

  it("marks the active step cancelled and skips later calls when its signal is aborted", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`print(text="first")
print(text="must not run")`, registry);
    const controller = new AbortController();
    controller.abort();

    const result = await workflow.execute(compiled.program!, [], { signal: controller.signal });

    expect(result.steps).toEqual([
      expect.objectContaining({ method: "print", state: "cancelled" }),
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
    expect(result.executions[1]?.result).toEqual({ kind: "ask", text: "hello" });
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

  it("renders structured print values as readable text", async () => {
    const { registry, runtime } = setup();
    const result = await runtime.execute({
      kind: "invocation",
      method: "print",
      source: "code",
      arguments: [{ name: "text", value: { kind: "ui", type: "confirm", confirmed: true } }]
    });
    expect(result.result).toEqual({
      kind: "print",
      text: '{"kind":"ui","type":"confirm","confirmed":true}'
    });
    const list = await runtime.execute({
      kind: "invocation",
      method: "print",
      source: "code",
      arguments: [{ name: "text", value: [{ value: 1 }, { value: 2 }] }]
    });
    expect(list.result).toMatchObject({ kind: "print", text: '[{"value":1},{"value":2}]' });
    const contract = new AxAdapter().compile(registry.get("print")!);
    expect(() => contract.inputSchema.parse({ text: { kind: "custom", value: 1 } })).not.toThrow();
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

  it("passes the workflow cancellation signal to the selected Agent runner", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    let received: AbortSignal | undefined;
    runtime.setAgentRunner({
      run: async (request) => {
        received = request.signal;
        return { kind: "agent", text: "done" };
      }
    });
    const controller = new AbortController();

    await runtime.execute({
      kind: "invocation",
      method: "agent",
      source: "code",
      arguments: [{ name: "input", value: "work" }]
    }, [], { signal: controller.signal });

    expect(received).toBe(controller.signal);
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
    const initial = 'input = """这段代码是什么含义\n"""\nagent(input=input)';
    const cursor = initial.indexOf("\n");
    const edit = fileReferenceInsertion(initial, cursor, cursor, ['@src/pathx.py#L55,1-L66,32']);
    const source = `${initial.slice(0, edit.from)}${edit.text}${initial.slice(edit.to)}`;

    expect(source).toContain('input = """这段代码是什么含义 @src/pathx.py#L55,1-L66,32\n"""');
    expect(source).toContain("agent(input=input)");
    expect(source).not.toContain('f"');
    expect(source).not.toContain("ref.file(");
    const compiled = compileWorkflow(source, registry);
    expect(compiled.diagnostics).toEqual([]);
    const result = await workflow.execute(compiled.program!);
    expect((result.executions[0]?.result as { text?: string }).text)
      .toBe("这段代码是什么含义 @src/pathx.py#L55,1-L66,32\n");
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
          ? { kind: "ask", text: "valid" }
          : { kind: "agent", text: "invalid", extra: true };
      }
    });

    await expect(runtime.execute({
      kind: "invocation", method: "ask", source: "code", arguments: [{ name: "input", value: "hello" }]
    })).resolves.toMatchObject({ result: { kind: "ask", text: "valid" } });
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

});

describe("formal UI workflows", () => {
  it("aborts the enclosing workflow when ui.form opts into on_cancel=abort", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow('ui.form(title="Confirm", fields=[], on_cancel="abort")\nprint(text="must not run")', registry);
    expect(compiled.diagnostics).toEqual([]);
    await expect(workflow.execute(compiled.program!, [], { ui: { form: async () => ({ kind: "ui", type: "form", status: "cancelled", answers: {} }) } }))
      .resolves.toMatchObject({ steps: [{ state: "cancelled" }, { state: "skipped" }] });
  });
  it("retries an interactive while step until the user confirms", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`reply = ui.confirm(message="Continue?")
while reply.confirmed != True:
    reply = ui.confirm(message="Continue?")
print(text="done")`, registry);
    expect(compiled.diagnostics).toEqual([]);
    let calls = 0;
    const response = await workflow.execute(compiled.program!, [], {
      ui: { form: async () => ({ kind: "ui", type: "form", status: calls++ === 0 ? "cancelled" : "submitted", answers: {} }) }
    });
    expect(response.executions.map((execution) => execution.method.id)).toEqual(["ui.confirm", "ui.confirm", "print"]);
  });

  it.each(["select", "radio", "checkbox", "input", "confirm", "alert", "form"])("executes ui.%s as one step", async (action) => {
    const { registry, workflow } = setup();
    const args = ["select", "radio", "checkbox"].includes(action) ? 'label="Pick", options=["a", "b"]'
      : action === "input" ? 'label="Text"' : action === "form" ? 'title="Form", fields=[]' : 'message="Continue?"';
    const compiled = compileWorkflow(`ui.${action}(${args})`, registry);
    expect(compiled.diagnostics).toEqual([]);
    const response = await workflow.execute(compiled.program!, [], { ui: { form: async (form) => ({ kind: "ui", type: "form", status: "submitted",
      answers: form.fields[0]?.type === "input" ? { answer: { type: "input", value: "" } }
        : ["select", "radio", "checkbox"].includes(action) ? { answer: { type: action as "select" | "radio" | "checkbox", selected: ["b"] } } : {} }) } });
    expect(response.executions).toHaveLength(1);
    expect(response.executions[0]?.result).toMatchObject({ kind: "ui", type: action });
  });
  it("executes a mixed declarative form and reads answers by stable ID", async () => {
    const { registry, workflow } = setup();
    const compiled = compileWorkflow(`fields = [{"id": "run", "type": "radio", "label": "Run?", "options": ["yes", "no"]}, {"id": "text", "type": "input", "label": "Details", "required": False}]
reply = ui.form(title="Settings", fields=fields)
if reply.status == "submitted":
    if reply.answers["run"].selected[0] == "no":
        print(text="No tests")`, registry);
    expect(compiled.diagnostics).toEqual([]);
    const response = await workflow.execute(compiled.program!, [], { ui: { form: async () => ({ kind: "ui", type: "form", status: "submitted", answers: { run: { type: "radio", selected: ["no"] } } }) } });
    expect(response.executions.map((execution) => execution.method.id)).toEqual(["ui.form", "print"]);
    expect(response.executions[1]?.result).toMatchObject({ text: "No tests" });
  });
  it("stops before later workflow steps when an interaction is aborted", async () => {
    const { registry, workflow } = setup(); const controller = new AbortController();
    const compiled = compileWorkflow('ui.input(label="Text")\nprint(text="must not run")', registry);
    let calls = 0;
    const response = await workflow.execute(compiled.program!, [], { signal: controller.signal, ui: { form: async () => {
      calls++; controller.abort(); return { kind: "ui", type: "form", status: "cancelled", answers: {} };
    } } });
    expect(response.executions).toEqual([]);
    expect(response.steps?.map((step) => step.state)).toEqual(["cancelled", "skipped"]);
    expect(calls).toBe(1);
  });
});
