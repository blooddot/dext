import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxAdapter } from "../src/core/axAdapter.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";
import { ExecutionCancelledError } from "../src/core/executionErrors.js";
import { parseMcpManifest } from "../src/core/mcpManifest.js";
import { MethodRegistry } from "../src/core/registry.js";
import { parseAgentResult } from "../src/core/resultBoundary.js";
import { DextRuntime, type RuntimeResultRepairRequest } from "../src/core/runtime.js";
import { mcpRawResultSchema } from "../src/core/schemas.js";
import { prepareHistoryTrace } from "../src/core/agentTraceReplay.js";
import type { AgentConversationRequest, AgentStructuredRequest } from "../src/core/agentRunner.js";
import type { UiFormDefinition } from "../src/core/uiForm.js";
import type {
  AgentResult,
  AgentStreamEvent,
  InvocationArgument,
  InvocationAst,
  InvocationValue,
  McpProcessEvent,
  PatchResult,
  TerminalResult
} from "../src/core/types.js";

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
  return { registry, runtime };
}

/** One InvocationAst argument, the only shape the runtime accepts. */
function arg(name: string, value: InvocationValue): InvocationArgument {
  return { name, value };
}

/** A code-sourced invocation, which is what the runtime executes directly now
 * that the language layer no longer compiles programs for it. */
function invoke(method: string, args: InvocationArgument[] = []): InvocationAst {
  return { kind: "invocation", method, arguments: args, source: "code" };
}

function agentCall(apply: boolean | undefined, input = "work"): InvocationAst {
  return invoke("agent", apply === undefined
    ? [arg("input", input)]
    : [arg("input", input), arg("apply", apply)]);
}

function selectFakeAgent(runtime: DextRuntime): void {
  runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
  runtime.setAgentSelection({ profileId: "codex" });
}

/** The public arguments each ui.* method requires. */
function uiArguments(action: string): InvocationArgument[] {
  if (["select", "radio", "checkbox"].includes(action)) return [arg("label", "Pick"), arg("options", ["a", "b"])];
  if (action === "input") return [arg("label", "Text")];
  if (action === "form") return [arg("title", "Form"), arg("fields", [])];
  return [arg("message", "Continue?")];
}

/** A trusted runtime whose registry carries one MCP manifest's methods. */
function mcpSetup(manifest: unknown): { registry: MethodRegistry; runtime: DextRuntime } {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const loaded = parseMcpManifest(JSON.stringify(manifest), "team.jsonc");
  expect(loaded.diagnostics).toEqual([]);
  registry.registerMany(loaded.methods, "project");
  const runtime = new DextRuntime(registry, new ContextResolver(host));
  runtime.setWorkspaceTrusted(true);
  return { registry, runtime };
}

describe("Dext runtime", () => {
  it("builds strict contracts for public builtins", () => {
    const { registry } = setup();
    const ask = new AxAdapter().compile(registry.get("ask")!);
    expect(ask.inputSchema.safeParse({ input: "hello" }).success).toBe(true);
    expect(ask.inputSchema.safeParse({ message: "hello" }).success).toBe(false);
    const agent = new AxAdapter().compile(registry.get("agent")!);
    expect(agent.outputSchema.safeParse({ kind: "agent", text: "done" }).success).toBe(true);
    expect(agent.outputSchema.safeParse({ kind: "agent", text: "done", extra: true }).success).toBe(false);
    expect(registry.get("chat")).toBeUndefined();
    expect(registry.get("code.edit")).toBeUndefined();
  });

  it("compiles strict contracts for terminal, ui.form and apply", () => {
    const { registry } = setup();
    const terminal = new AxAdapter().compile(registry.get("terminal")!);
    expect(terminal.inputSchema.safeParse({ command: "echo hi" }).success).toBe(true);
    expect(terminal.inputSchema.safeParse({ command: "echo hi", extra: true }).success).toBe(false);
    expect(terminal.outputJsonSchema).toMatchObject({
      properties: { status: { enum: ["succeeded", "failed", "timed_out"] } }
    });

    const form = new AxAdapter().compile(registry.get("ui.form")!);
    expect(form.inputSchema.safeParse({ title: "Review", fields: [] }).success).toBe(true);
    expect(form.inputSchema.safeParse({ fields: [] }).success).toBe(false);
    expect(form.outputSchema.safeParse({ kind: "ui", type: "form", status: "cancelled", answers: {} }).success).toBe(true);
    expect(form.outputSchema.safeParse({ kind: "ui", type: "confirm", confirmed: true }).success).toBe(false);

    const apply = new AxAdapter().compile(registry.get("apply")!);
    expect(apply.inputSchema.safeParse({ result: { kind: "ask", text: "x" } }).success).toBe(true);
    expect(apply.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown methods, duplicate arguments and wrong argument types", async () => {
    const { runtime } = setup();
    await expect(runtime.execute(invoke("nope"))).rejects.toThrow("Unknown method 'nope'.");
    await expect(runtime.execute(invoke("ask", [arg("input", "a"), arg("input", "b")])))
      .rejects.toThrow("Argument 'input' is provided more than once.");
    await expect(runtime.execute(invoke("ask", [arg("input", 123)]))).rejects.toThrow(/input/);
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
    await runtime.execute(invoke("terminal", [
      arg("command", "tool run"),
      arg("env", { TASK_TITLE: "Login fails" })
    ]));
    expect(received).toMatchObject({ command: "tool run", env: { TASK_TITLE: "Login fails" } });
  });

  it("returns the terminal handler's complete result unchanged", async () => {
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
    const response = await runtime.execute(invoke("terminal", [arg("command", "exit 7")]));
    expect(response.result).toEqual(terminalResult);
  });

  it.each(["select", "radio", "checkbox", "input", "confirm", "alert", "form"])(
    "runs ui.%s through metadata.ui and returns its typed result",
    async (action) => {
      const { runtime } = setup();
      const forms: UiFormDefinition[] = [];
      const response = await runtime.execute(invoke(`ui.${action}`, uiArguments(action)), [], {
        ui: {
          form: async (form) => {
            forms.push(form);
            return { kind: "ui", type: "form", status: "cancelled", answers: {} };
          }
        }
      });
      expect(forms).toHaveLength(1);
      expect(response.method.id).toBe(`ui.${action}`);
      expect(response.result).toMatchObject({ kind: "ui", type: action });
    }
  );

  it("requires an interactive host for ui handlers", async () => {
    const { runtime } = setup();
    await expect(runtime.execute(invoke("ui.confirm", [arg("message", "Continue?")])))
      .rejects.toThrow("requires an interactive Dext host");
  });

  it("returns a submitted form with the pressed action and its validated answers", async () => {
    const { runtime } = setup();
    const response = await runtime.execute(
      invoke("ui.form", [
        arg("title", "Review"),
        arg("fields", [{ id: "run", type: "radio", label: "Run?", options: ["yes", "no"] }]),
        arg("actions", [{ id: "approve", label: "Approve" }, { id: "revise", label: "Revise" }])
      ]),
      [],
      {
        ui: {
          form: async () => ({
            kind: "ui",
            type: "form",
            status: "submitted",
            answers: { run: { type: "radio", selected: ["no"] } },
            action: "revise"
          })
        }
      }
    );
    expect(response.result).toEqual({
      kind: "ui",
      type: "form",
      status: "submitted",
      answers: { run: { type: "radio", selected: ["no"] } },
      action: "revise"
    });
  });

  it("rejects a submitted form that names no action", async () => {
    const { runtime } = setup();
    await expect(runtime.execute(
      invoke("ui.form", [
        arg("title", "Review"),
        arg("fields", []),
        arg("actions", [{ id: "approve", label: "Approve" }, { id: "revise", label: "Revise" }])
      ]),
      [],
      { ui: { form: async () => ({ kind: "ui", type: "form", status: "submitted", answers: {} }) } }
    )).rejects.toThrow("Choose a form action.");
  });

  it("aborts the invocation when ui.form opts into on_cancel=abort", async () => {
    const { runtime } = setup();
    await expect(runtime.execute(
      invoke("ui.form", [arg("title", "Confirm"), arg("fields", []), arg("on_cancel", "abort")]),
      [],
      { ui: { form: async () => ({ kind: "ui", type: "form", status: "cancelled", answers: {} }) } }
    )).rejects.toThrow(ExecutionCancelledError);
  });

  it("reports a deterministic handler that needs a configured Agent profile", async () => {
    const { runtime } = setup();
    await expect(runtime.execute(invoke("skill", [arg("skill", "demo"), arg("input", "go")])))
      .rejects.toThrow("skill requires a configured Agent profile");
  });

  it("renders a trusted template only with an Agent profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-template-"));
    try {
      await writeFile(join(root, "plan.md"), [
        "---",
        "dext-template:",
        "  format: markdown",
        "  title:",
        "    type: string",
        "    description: A short title",
        "---",
        "# {{title}}",
        ""
      ].join("\n"));
      const { runtime } = setup();
      runtime.setWorkspaceRoot(root);
      const call = invoke("template", [arg("input", "write it"), arg("source", "plan.md")]);
      await expect(runtime.execute(call)).rejects.toThrow("template requires a trusted local workspace");
      runtime.setWorkspaceTrusted(true);
      await expect(runtime.execute(call)).rejects.toThrow("template requires a configured Agent profile");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("applies an empty patch as unchanged and refuses non-empty changes without a workspace host", async () => {
    const { runtime } = setup();
    const patch: PatchResult = { kind: "patch", title: "No changes", changes: [] };
    const preview: AgentResult = { kind: "agent", text: "preview", patch };
    await expect(runtime.execute(invoke("apply", [arg("result", preview)]))).resolves.toMatchObject({
      result: { kind: "apply", status: "unchanged", files: [], summary: expect.stringContaining("no changes") }
    });

    const changed: AgentResult = {
      kind: "agent",
      text: "preview",
      patch: { kind: "patch", title: "Edit", changes: [{ uri: "file:///x.ts", before: "a", after: "b" }] }
    };
    await expect(runtime.execute(invoke("apply", [arg("result", changed)])))
      .rejects.toThrow("apply requires a workspace patch host for non-empty changes.");
  });

  it("accepts a JSON object in content for a typed MCP result", async () => {
    const { runtime } = mcpSetup({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{
        name: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { code: { type: "integer" } } }
      }]
    });
    runtime.setMcpCaller(async () => ({
      kind: "mcpRaw",
      server: "team",
      tool: "query",
      content: JSON.stringify({ code: 200 })
    }));
    const response = await runtime.execute(invoke("mcp.team.query"));
    expect(response.result).toMatchObject({ kind: "mcp.team.query", code: 200 });
  });

  it("accepts JSON objects wrapped in an MCP server response prefix", async () => {
    const { runtime } = mcpSetup({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{
        name: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { result: { type: "array" } } }
      }]
    });
    runtime.setMcpCaller(async () => ({
      kind: "mcpRaw",
      server: "team",
      tool: "query",
      content: `API Response (Status: 200):\n${JSON.stringify({ result: [{ id: "t1" }] })}`
    }));
    const response = await runtime.execute(invoke("mcp.team.query"));
    expect(response.result).toMatchObject({ kind: "mcp.team.query", result: [{ id: "t1" }] });
  });

  it("adapts structuredContent into the declared mcp.<server>.<tool> kind", async () => {
    const { runtime } = mcpSetup({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{
        name: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { result: { type: "array", items: { type: "object", properties: { id: { type: "string" } } } } }
        }
      }]
    });
    runtime.setMcpCaller(async () => ({
      kind: "mcpRaw",
      server: "team",
      tool: "query",
      structured: { result: [{ id: "t1" }] }
    }));
    const response = await runtime.execute(invoke("mcp.team.query"));
    // The internal mcpRaw envelope never leaks into a typed result.
    expect(response.result).toEqual({ kind: "mcp.team.query", result: [{ id: "t1" }] });
  });

  it("rejects typed MCP content that is not a JSON object", async () => {
    const { runtime } = mcpSetup({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{
        name: "query",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { code: { type: "integer" } } }
      }]
    });
    runtime.setMcpCaller(async () => ({ kind: "mcpRaw", server: "team", tool: "query", content: "plain text" }));
    await expect(runtime.execute(invoke("mcp.team.query"))).rejects.toThrow(/structuredContent/);
  });

  it("returns a raw mcpRaw result when the manifest declares no output schema", async () => {
    const { runtime } = mcpSetup({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }]
    });
    runtime.setMcpCaller(async () => ({ kind: "mcpRaw", server: "team", tool: "ping", content: "pong" }));
    const response = await runtime.execute(invoke("mcp.team.ping"));
    expect(response.result).toEqual({ kind: "mcpRaw", server: "team", tool: "ping", content: "pong" });
    expect(mcpRawResultSchema.safeParse({ kind: "mcpRaw", server: "team", tool: "ping" }).success).toBe(true);
    expect(mcpRawResultSchema.safeParse({ kind: "mcpRaw", server: "team", tool: "ping", extra: true }).success).toBe(false);
  });

  it("gates MCP tools on workspace trust and a configured caller", async () => {
    const { runtime } = mcpSetup({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }]
    });
    runtime.setWorkspaceTrusted(false);
    await expect(runtime.execute(invoke("mcp.team.ping")))
      .rejects.toThrow("MCP tools require a trusted local workspace.");
    runtime.setWorkspaceTrusted(true);
    await expect(runtime.execute(invoke("mcp.team.ping")))
      .rejects.toThrow("MCP registry is not configured.");
  });

  it("forwards MCP process events to metadata.onMcpEvent", async () => {
    const { runtime } = mcpSetup({
      name: "team",
      transport: "stdio",
      command: "team-mcp",
      tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }]
    });
    const events: McpProcessEvent[] = [];
    runtime.setMcpCaller(async (_tool, _input, onProcessEvent) => {
      onProcessEvent?.({ source: "stderr", text: "connecting" });
      return { kind: "mcpRaw", server: "team", tool: "ping", content: "pong" };
    });
    await runtime.execute(invoke("mcp.team.ping"), [], { onMcpEvent: (event) => events.push(event) });
    expect(events).toEqual([{ source: "stderr", text: "connecting" }]);
  });

  it("explains an unknown MCP tool through the declared-tool advice", async () => {
    const { runtime } = setup();
    runtime.setDeclaredMcpTools(["mcp.team.query"]);
    await expect(runtime.execute(invoke("mcp.team.query")))
      .rejects.toThrow("is not connected or the tool is not registered");
    runtime.setMcpServerDiagnostics(["MCP server 'team' was rejected: bad transport."]);
    await expect(runtime.execute(invoke("mcp.team.query")))
      .rejects.toThrow("was rejected: bad transport.");
  });

  it("keeps a sandbox-escaping preset off read-only turns and applies it when the turn is writable", async () => {
    const { runtime } = setup();
    const conversations: AgentConversationRequest[] = [];
    const invocations: { allowWorkspaceWrite: boolean | undefined; agentPreset: string | undefined }[] = [];
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{
      id: "deepseek-harness", provider: "deepseek-harness", command: "dsh", label: "Harness", models: [],
      presets: [
        { id: "standard", label: "Standard", description: "", builtin: true, requiresFullAccess: false, writableTurnsOnly: false },
        { id: "minimal", label: "Minimal", description: "", builtin: true, requiresFullAccess: true, writableTurnsOnly: true }
      ]
    }]);
    runtime.setAgentSelection({ profileId: "deepseek-harness", permission: "full-access", agentPreset: "minimal" });
    runtime.setAgentRunner({
      run: async (request) => {
        invocations.push({ allowWorkspaceWrite: request.allowWorkspaceWrite, agentPreset: request.agentPreset });
        return { kind: "agent", text: "done" };
      },
      runConversation: async (request) => {
        conversations.push(request);
        return "answer";
      }
    });

    // Plan generation and Ask are read-only; building a plan and Agent are writable.
    await runtime.executeConversation("ask", "explain");
    await runtime.executeConversation("plan", "plan it");
    await runtime.executeConversation("plan", "build it", { executePlan: true });
    await runtime.executeConversation("agent", "implement");
    expect(conversations.map((item) => item.agentPreset)).toEqual(["standard", "standard", "minimal", "minimal"]);

    await runtime.execute(invoke("agent", [arg("input", "preview"), arg("apply", false)]));
    await runtime.execute(invoke("agent", [arg("input", "write")]));
    expect(invocations.map((item) => item.agentPreset)).toEqual(["standard", "minimal"]);
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

  it("carries a caller-owned schema through the provider's native structured channel", async () => {
    const { runtime } = setup();
    const structured: AgentStructuredRequest[] = [];
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex", model: "gpt-selected" });
    runtime.setWorkspaceRoot("C:/workspace");
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "typed" }),
      runStructured: async (request) => {
        structured.push(request);
        return '{"title":"Model"}';
      }
    });
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };

    const result = await runtime.executeStructuredJson("Generate the model.", schema);

    expect(result).toEqual({ text: '{"title":"Model"}', model: "gpt-selected" });
    expect(structured).toHaveLength(1);
    expect(structured[0]?.profile.id).toBe("codex");
    expect(structured[0]?.input).toBe("Generate the model.");
    expect(structured[0]?.outputSchema).toBe(schema);
    // The selection the composer shows is what a Project turn runs under.
    expect(structured[0]?.model).toBe("gpt-selected");
  });

  it("keeps a Project turn's workspace-trust gate on extra CLI arguments", async () => {
    const { runtime } = setup();
    const structured: AgentStructuredRequest[] = [];
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentCliArguments({ codex: ["--dangerously-bypass"] });
    runtime.setAgentRunner({ run: async () => ({ kind: "ask", text: "typed" }), runStructured: async (request) => { structured.push(request); return "{}"; } });

    await runtime.executeStructuredJson("prompt", { type: "object" });
    runtime.setWorkspaceTrusted(true);
    await runtime.executeStructuredJson("prompt", { type: "object" });

    expect(structured[0]?.cliArguments).toBeUndefined();
    expect(structured[1]?.cliArguments).toEqual(["--dangerously-bypass"]);
  });

  it("rejects native structured output on a backend that has no schema channel", async () => {
    const { runtime } = setup();
    runtime.setAgentProfiles([{ id: "deepseek-harness", label: "Harness", provider: "deepseek-harness", command: "dsh", models: [] }]);
    runtime.setAgentSelection({ profileId: "deepseek-harness" });
    runtime.setAgentRunner({ run: async () => ({ kind: "ask", text: "typed" }) });
    await expect(runtime.executeStructuredJson("prompt", { type: "object" }))
      .rejects.toThrow(/native structured output/);
  });

  it("runs the Harness default preset for a conversation that never chose one", async () => {
    const { runtime } = setup();
    const conversations: AgentConversationRequest[] = [];
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{
      id: "deepseek-harness", provider: "deepseek-harness", command: "dsh", label: "Harness", models: [],
      presets: [
        { id: "standard", label: "Standard", description: "", builtin: true, requiresFullAccess: false, writableTurnsOnly: false },
        { id: "ptc", label: "PTC", description: "", builtin: true, requiresFullAccess: false, writableTurnsOnly: false }
      ]
    }]);
    // An unset selection - a new conversation, or one persisted before presets
    // were mandatory - mounts the Harness default, never the raw ACP profile
    // composition that Dext no longer offers.
    runtime.setAgentSelection({ profileId: "deepseek-harness", permission: "workspace-write", agentPreset: "" });
    runtime.setAgentRunner({
      run: async () => ({ kind: "agent", text: "done" }),
      runConversation: async (request) => { conversations.push(request); return "answer"; }
    });

    await runtime.executeConversation("ask", "explain");
    await runtime.executeConversation("agent", "implement");
    expect(conversations.map((item) => item.agentPreset)).toEqual(["standard", "standard"]);
  });

  it("keeps an installed Harness without a preset catalog on its own ACP composition", async () => {
    const { runtime } = setup();
    const conversations: AgentConversationRequest[] = [];
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "deepseek-harness", provider: "deepseek-harness", command: "dsh", label: "Harness", models: [], presets: [] }]);
    runtime.setAgentSelection({ profileId: "deepseek-harness", permission: "workspace-write", agentPreset: "" });
    runtime.setAgentRunner({
      run: async () => ({ kind: "agent", text: "done" }),
      runConversation: async (request) => { conversations.push(request); return "answer"; }
    });

    await runtime.executeConversation("agent", "implement");
    expect(conversations.map((item) => item.agentPreset)).toEqual([""]);
  });

  it("keeps apply and terminal local when an Agent is selected", async () => {
    const { runtime } = setup();
    let invoked = false;
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentRunner({ run: async () => { invoked = true; return { kind: "ask", text: "agent" }; } });
    await expect(runtime.execute(invoke("terminal", [arg("command", "echo local")])))
      .resolves.toMatchObject({ result: { kind: "terminal" } });
    const preview: AgentResult = { kind: "agent", text: "preview", patch: { kind: "patch", title: "No changes", changes: [] } };
    await expect(runtime.execute(invoke("apply", [arg("result", preview)])))
      .resolves.toMatchObject({ result: { kind: "apply", status: "unchanged" } });
    expect(invoked).toBe(false);
  });

  it("routes ask through the selected Agent runner", async () => {
    const { runtime } = setup();
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentRunner({ run: async () => ({ kind: "ask", text: "agent response" }) });
    await expect(runtime.execute(invoke("ask", [arg("input", "hello")])))
      .resolves.toMatchObject({ result: { kind: "ask", text: "agent response" } });
  });

  it("routes a typed agent call to the CLI named by the cli argument", async () => {
    const { runtime } = setup();
    const providers: string[] = [];
    runtime.setAgentProfiles([
      { id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] },
      { id: "claude", label: "Claude", provider: "claude", command: "claude", models: [] }
    ]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setAgentRunner({
      run: async (request) => {
        providers.push(request.profile.provider);
        return { kind: "agent", text: "done" };
      }
    });
    await runtime.execute(invoke("agent", [arg("input", "work"), arg("apply", false), arg("cli", "claude")]));
    expect(providers).toEqual(["claude"]);
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

    await runtime.execute(invoke("agent", [
      arg("input", "implement"),
      arg("apply", false),
      arg("skills", ["project", "testing", "project"]),
      arg("rules", ["dev/base.md", "dev/phase.md"])
    ]));

    expect(instruction).toBe([
      "Follow the skill 'project' from project/SKILL.md for this agent call.\n\nskill project",
      "Follow the skill 'testing' from testing/SKILL.md for this agent call.\n\nskill testing",
      "Apply rule 'dev/base.md':\n\nbase rule",
      "Apply rule 'dev/phase.md':\n\nphase rule"
    ].join("\n\n"));
    await expect(runtime.execute(invoke("agent", [
      arg("input", "implement"),
      arg("apply", false),
      arg("rules", ["../api/dev/feat.md"])
    ]))).rejects.toThrow("rules must stay below .dext/rules.");
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

  it("keeps a streamed Plan document out of Process while returning the full reply", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: [] }]);
    runtime.setAgentSelection({ profileId: "codex" });
    runtime.setRuleLoader(async () => undefined);
    const reply = "Brief.\n<!-- dext-plan:start -->\n# Plan\n<!-- dext-plan:end -->\nTail.";
    runtime.setAgentRunner({
      run: async () => ({ kind: "ask", text: "unused" }),
      runConversation: async (request) => {
        // Every provider emits the same AgentStreamEvent contract: text
        // deltas, optionally followed by an authoritative snapshot.
        const onEvent = request.onEvent;
        if (!onEvent) throw new Error("Expected the runtime to install an event sink.");
        onEvent({ id: "m1", phase: "message", text: "Brief.\n" });
        onEvent({ id: "m1", phase: "message", text: "<!-- dext-plan:start -->" });
        onEvent({ id: "m1", phase: "message", text: "\n# Plan\n" });
        onEvent({ id: "m1", phase: "message", text: "<!-- dext-plan:end -->" });
        onEvent({ id: "m1", phase: "message", text: reply, replace: true, done: true });
        return reply;
      }
    });
    const events: AgentStreamEvent[] = [];
    const response = await runtime.executeConversation("plan", "Add a cache", {
      onAgentEvent: (event) => events.push(event)
    });

    // The response still carries the complete document from the reply text.
    expect(response.result).toMatchObject({ kind: "plan", text: reply });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => !(event.text ?? "").includes("dext-plan"))).toBe(true);
    expect(prepareHistoryTrace(events).map((event) => event.text)).toEqual(["Brief.\n\nTail."]);
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

  it("keeps agent previews read-only and gates workspace writes on trust", async () => {
    const { runtime } = setup();
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setAgentProfiles([{ id: "codex", label: "Codex", provider: "codex", command: "codex", models: ["gpt-test"] }]);
    runtime.setAgentSelection({ profileId: "codex", model: "gpt-test" });
    const requests: { allowWorkspaceWrite: boolean | undefined; permission: string | undefined; cwd: string }[] = [];
    runtime.setAgentRunner({
      run: async (request) => {
        requests.push({ allowWorkspaceWrite: request.allowWorkspaceWrite, permission: request.permission, cwd: request.cwd });
        return { kind: "agent", text: "done" };
      }
    });

    await expect(runtime.execute(agentCall(false, "preview"))).resolves.toMatchObject({ result: { kind: "agent", text: "done" } });
    expect(requests).toEqual([{ allowWorkspaceWrite: false, permission: "read-only", cwd: process.cwd() }]);

    await expect(runtime.execute(agentCall(undefined, "write"))).rejects.toThrow("trusted local workspace");
    expect(requests).toHaveLength(1);

    runtime.setWorkspaceTrusted(true);
    await runtime.execute(agentCall(undefined, "write"));
    expect(requests[1]).toEqual({ allowWorkspaceWrite: true, permission: "workspace-write", cwd: process.cwd() });

    runtime.setAgentSelection({ profileId: "codex", permission: "full-access" });
    await runtime.execute(agentCall(false, "full access preview"));
    expect(requests[2]).toEqual({ allowWorkspaceWrite: false, permission: "read-only", cwd: process.cwd() });

    await runtime.execute(agentCall(undefined, "full access write"), [], { agentPermission: "full-access" });
    expect(requests[3]).toEqual({ allowWorkspaceWrite: true, permission: "full-access", cwd: process.cwd() });
  });

  it("passes the cancellation signal to the selected Agent runner", async () => {
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

    await runtime.execute(agentCall(undefined), [], { signal: controller.signal });

    expect(received).toBe(controller.signal);
  });

  it("keeps @ tokens readable in an ask input without resolving file content", async () => {
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
    const runtime = new DextRuntime(registry, new ContextResolver(orderedHost));

    const response = await runtime.execute(invoke("ask", [arg("input", "A @first.ts B @selection C")]));

    expect(resolved).toEqual([]);
    expect(response.result).toEqual({ kind: "ask", text: "A @first.ts B @selection C" });
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

    await expect(runtime.execute(invoke("ask", [arg("input", "hello")])))
      .resolves.toMatchObject({ result: { kind: "ask", text: "valid" } });
    await expect(runtime.execute(agentCall(false, "preview"))).rejects.toThrow();
    expect(models).toEqual(["gpt-test", "gpt-test"]);
  });

  it("rejects an execution whose signal is already aborted", async () => {
    const { runtime } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.execute(invoke("ask", [arg("input", "hello")]), [], { signal: controller.signal }))
      .rejects.toThrow(ExecutionCancelledError);
  });

  it("rejects an aborted conversation before contacting the provider", async () => {
    const { runtime } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.executeConversation("ask", "explain", { signal: controller.signal }))
      .rejects.toThrow(ExecutionCancelledError);
  });

  it("cancels a ui interaction whose signal aborts while the host is answering", async () => {
    const { runtime } = setup();
    const controller = new AbortController();
    await expect(runtime.execute(
      invoke("ui.confirm", [arg("message", "Continue?")]),
      [],
      {
        signal: controller.signal,
        ui: {
          form: async () => {
            controller.abort();
            return { kind: "ui", type: "form", status: "cancelled", answers: {} };
          }
        }
      }
    )).rejects.toThrow(ExecutionCancelledError);
  });
});

describe("Dext result repair", () => {
  it("parses a fenced Agent result with surrounding narration", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setAgentRunner({
      run: async () => ["Here is the result:", "```json", JSON.stringify({ kind: "agent", text: "done" }), "```", "That is all."].join("\n\n")
    });

    await expect(runtime.execute(agentCall(false))).resolves.toMatchObject({
      result: { kind: "agent", text: "done" }
    });
  });

  it("repairs an invalid Agent result once with the full invocation context", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setAgentRunner({
      run: async () => ({ kind: "agent", text: "needs repair", extra: true })
    });
    const requests: RuntimeResultRepairRequest[] = [];
    runtime.setResultRepair({
      parse: parseAgentResult,
      repair: async (request) => {
        requests.push(request);
        return { result: { kind: "agent", text: "repaired" } };
      }
    });

    await expect(runtime.execute(agentCall(false))).resolves.toMatchObject({
      result: { kind: "agent", text: "repaired" }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "agent",
      allowWorkspaceWrite: false,
      includePatch: true,
      profile: { id: "codex" }
    });
    expect(requests[0]!.diagnostics).not.toBe("");
    expect(requests[0]!.diagnostics).toMatch(/extra/i);
    expect(requests[0]!.raw).toContain("needs repair");
  });

  it("repairs a result whose kind does not match the invoked method", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    // A tolerant parser may hand back an envelope for another method; that is repairable, so it must
    // reach the predictor instead of failing immediately.
    runtime.setAgentRunner({
      run: async () => JSON.stringify({ kind: "ask", text: "answered the wrong method" })
    });
    const requests: RuntimeResultRepairRequest[] = [];
    runtime.setResultRepair({
      parse: () => ({ kind: "ask", text: "answered the wrong method" }),
      repair: async (request) => {
        requests.push(request);
        return { result: { kind: "agent", text: "converted" } };
      }
    });

    await expect(runtime.execute(agentCall(false))).resolves.toMatchObject({
      result: { kind: "agent", text: "converted" }
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.diagnostics).toMatch(/does not match/i);
  });

  it("does not repair a write-enabled Agent turn", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentRunner({
      run: async () => ({ kind: "agent", text: "wrote files", extra: true })
    });
    let repaired = false;
    runtime.setResultRepair({
      parse: parseAgentResult,
      repair: async () => { repaired = true; return { result: { kind: "agent", text: "repaired" } }; }
    });

    await expect(runtime.execute(agentCall(undefined))).rejects.toThrow();
    expect(repaired).toBe(false);
  });

  it("reports diagnostics and the raw snippet when repair is not configured", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setAgentRunner({
      run: async () => ({ kind: "agent", text: "unparseable", extra: true })
    });

    await expect(runtime.execute(agentCall(false))).rejects.toThrow(/Raw output \(first 200 characters\):[\s\S]*unparseable/);
    await expect(runtime.execute(agentCall(false))).rejects.toThrow(/extra/i);
  });

  it("passes the cancellation signal through to the repair predictor", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setAgentRunner({
      run: async () => ({ kind: "agent", text: "bad", extra: true })
    });
    let received: AbortSignal | undefined;
    runtime.setResultRepair({
      parse: parseAgentResult,
      repair: async (request) => {
        received = request.signal;
        return { diagnostics: "repair failed" };
      }
    });
    const controller = new AbortController();

    await expect(runtime.execute(agentCall(false), [], { signal: controller.signal }))
      .rejects.toThrow(/Repair failed: repair failed/);
    expect(received).toBe(controller.signal);
  });

  it("does not repair raw output above the 20k character budget", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    // A schema-invalid object, not plain text: plain `agent` text now wraps as a
    // valid result before repair is ever considered.
    runtime.setAgentRunner({ run: async () => JSON.stringify({ kind: "agent", text: "x".repeat(20_001), extra: true }) });
    let repaired = false;
    runtime.setResultRepair({
      parse: parseAgentResult,
      repair: async () => { repaired = true; return { result: { kind: "agent", text: "repaired" } }; }
    });

    await expect(runtime.execute(agentCall(false))).rejects.toThrow(/extra/i);
    expect(repaired).toBe(false);
  });

  it("diagnoses harness-style invalid final text instead of rethrowing provider errors", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setAgentRunner({ run: async () => "invalid" });
    runtime.setResultRepair({
      parse: parseAgentResult,
      repair: async () => ({ diagnostics: "not available" })
    });

    // The `agent` kind is the one that wraps plain text; every other kind keeps
    // the old diagnose-and-repair path.
    await expect(runtime.execute(invoke("ask", [arg("input", "hi")])))
      .rejects.toThrow(/No 'ask' JSON object could be extracted[\s\S]*Repair failed: not available/);
  });

  it("treats explicitly null optional fields as absent instead of repairing", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    // Dext's Codex schema marks the optional result fields required-but-nullable, so the model
    // answers `"patch": null` to mean "there is no patch". That must validate, not fail.
    runtime.setAgentRunner({
      run: async () => JSON.stringify({ kind: "agent", text: "分析完成", summary: null, patch: null, files: null })
    });
    let repaired = false;
    runtime.setResultRepair({
      parse: parseAgentResult,
      repair: async () => { repaired = true; return { result: { kind: "agent", text: "repaired" } }; }
    });

    await expect(runtime.execute(agentCall(false))).resolves.toMatchObject({
      result: { kind: "agent", text: "分析完成" }
    });
    expect(repaired).toBe(false);
  });

  it("drops nested nulls so a Codex patch result still validates", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setAgentRunner({
      run: async () => JSON.stringify({
        kind: "agent",
        text: "patched",
        patch: {
          kind: "patch",
          title: "edit",
          changes: [{ uri: "file:///x.ts", before: "a", after: "b", range: null, documentVersion: null, contentHash: null }]
        },
        files: null
      })
    });

    const response = await runtime.execute(agentCall(false));
    expect(response.result).toMatchObject({
      kind: "agent",
      patch: { kind: "patch", title: "edit", changes: [{ uri: "file:///x.ts", before: "a", after: "b" }] }
    });
    expect(JSON.stringify(response.result)).not.toContain("null");
  });

  it("wraps a plain-Markdown agent result as its text instead of discarding the turn", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    const markdown = [
      "[DEV_PLAN_TASKLIST] T1,T2,T4",
      "",
      "| ID | Task | Status |",
      "| --- | --- | --- |",
      "| T1 | Load rules | pending |"
    ].join("\n");
    runtime.setAgentRunner({ run: async () => markdown });
    const events: AgentStreamEvent[] = [];

    const response = await runtime.execute(agentCall(false), [], { onAgentEvent: (event) => events.push(event) });

    expect(response.result).toEqual({ kind: "agent", text: markdown });
    expect(events.some((event) => event.title?.includes("fell back to plain-text wrapping"))).toBe(true);
  });

  it("leaves a valid agent JSON envelope on the normal path", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setAgentRunner({ run: async () => JSON.stringify({ kind: "agent", text: "typed" }) });
    const events: AgentStreamEvent[] = [];

    const response = await runtime.execute(agentCall(false), [], { onAgentEvent: (event) => events.push(event) });

    expect(response.result).toEqual({ kind: "agent", text: "typed" });
    expect(events.some((event) => event.title?.includes("fell back to plain-text wrapping"))).toBe(false);
  });

  it("does not wrap a plain-text result for a non-agent kind", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setAgentRunner({ run: async () => "plain text without any envelope" });

    await expect(runtime.execute(invoke("ask", [arg("input", "hi")])))
      .rejects.toThrow(/No 'ask' JSON object could be extracted/);
  });

  it("does not wrap a plain-text result on a write-enabled Agent turn", async () => {
    const { runtime } = setup();
    selectFakeAgent(runtime);
    runtime.setWorkspaceRoot(process.cwd());
    runtime.setWorkspaceTrusted(true);
    runtime.setAgentRunner({ run: async () => "edited files\n\n| a | b |" });
    const events: AgentStreamEvent[] = [];

    await expect(runtime.execute(agentCall(undefined), [], { onAgentEvent: (event) => events.push(event) }))
      .rejects.toThrow(/No 'agent' JSON object could be extracted/);
    expect(events.some((event) => event.title?.includes("fell back to plain-text wrapping"))).toBe(false);
  });
});
