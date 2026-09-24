import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentPayload,
  agentProcessEnvironment,
  claudeConversationArguments,
  claudeCliArguments,
  claudePermissionMode,
  CliAgentRunner,
  codexConversationArguments,
  codexCliArguments,
  codexOutputSchema,
  codexSandbox,
  permissionForWrite,
  extractConversationText,
  extractCodexThreadId,
  extractClaudeResult,
  agentTokenUsage,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  resolveCliCommand,
  runProcess,
  type AgentConversationRequest,
  type AgentExecutionRequest,
  type AgentStructuredRequest
} from "../src/core/agentRunner.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { AxAdapter } from "../src/core/axAdapter.js";
import { serializeResultForAgent } from "../src/core/resultSerialization.js";
import type { AgentProfile } from "../src/agentProfiles.js";
import type { AgentStreamEvent, RegisteredCallable } from "../src/core/types.js";

const temporaryDirectories: string[] = [];

function request(): AgentExecutionRequest {
  const method: RegisteredCallable = {
    ...BUILTIN_METHODS.find((candidate) => candidate.id === "ask")!,
    source: "builtin"
  };
  const profile: AgentProfile = {
    id: "codex",
    label: "Codex",
    provider: "codex",
    command: "codex",
    models: []
  };
  return {
    profile,
    cwd: "C:/workspace",
    method,
    contract: new AxAdapter().compile(method),
    resolved: {
      invocation: { kind: "invocation", method: "ask", arguments: [{ name: "input", value: "Hello" }], source: "chat" },
      method,
      arguments: { input: "Hello" },
      context: [],
      metadata: {}
    },
    metadata: {}
  };
}

function conversationRequest(input: string, agentSessionId: string): AgentConversationRequest {
  return {
    profile: {
      id: "codex",
      label: "Codex",
      provider: "codex",
      command: process.execPath,
      models: []
    },
    mode: "ask",
    cwd: process.cwd(),
    input,
    metadata: { agentSessionId },
    allowWorkspaceWrite: false,
    permission: "read-only"
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CLI command resolution", () => {
  it("lets a confirmed ChatGPT login take precedence over inherited API keys", () => {
    expect(agentProcessEnvironment("codex", true, {
      OPENAI_API_KEY: "stale-openai-key",
      CODEX_API_KEY: "stale-codex-key",
      KEEP_ME: "value"
    })).toEqual({ KEEP_ME: "value" });
    expect(agentProcessEnvironment("codex", false, { OPENAI_API_KEY: "api-key" })).toBeUndefined();
    expect(agentProcessEnvironment("claude", true, { OPENAI_API_KEY: "api-key" })).toBeUndefined();
  });

  it("wraps prior API results in a stable Agent CLI envelope", () => {
    expect(serializeResultForAgent({ kind: "ask", text: "hello" } as const)).toEqual({
      kind: "dext-result",
      version: 1,
      result_kind: "ask",
      value: { kind: "ask", text: "hello" }
    });
  });

  it("keeps Codex progress messages in the visible agent trace", () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "I will inspect the target first." }
    }))).toMatchObject({ id: "item_0", phase: "message", text: "I will inspect the target first.", done: true });
  });

  it("does not show Codex request items as Process messages", () => {
    for (const type of ["user_message", "developer_message"]) {
      expect(parseCodexStreamLine(JSON.stringify({
        type: "item.completed",
        item: { id: `request-${type}`, type, content: "the complete Plan prompt and document" }
      }))).toBeUndefined();
      expect(parseCodexStreamLine(JSON.stringify({
        type,
        text: "the complete Plan prompt and document"
      }))).toBeUndefined();
      expect(parseCodexStreamLine(JSON.stringify({
        type: `item.${type}`,
        text: "the complete Plan prompt and document"
      }))).toBeUndefined();
    }
  });

  it("passes Codex message text through for the Process boundary to guard", () => {
    const text = "已更新计划。\n<!-- dext-plan:start -->\n# 完整计划\n<!-- dext-plan:end -->";
    expect(parseCodexStreamLine(JSON.stringify({
      type: "item.completed",
      item: { id: "plan-result", type: "agent_message", text }
    }))).toMatchObject({ phase: "message", text, done: true });
  });

  it("captures provider-reported token usage from completed Codex and Claude turns", () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1_000, cached_input_tokens: 250, output_tokens: 300 }
    }))).toMatchObject({
      phase: "status",
      done: true,
      usage: { inputTokens: 1_000, cachedInputTokens: 250, outputTokens: 300 }
    });
    expect(parseClaudeStreamLine(JSON.stringify({
      type: "result",
      usage: { input_tokens: 500, output_tokens: 120, total_tokens: 620 }
    }))).toMatchObject({
      phase: "status",
      done: true,
      usage: { inputTokens: 500, outputTokens: 120, totalTokens: 620 }
    });
    expect(agentTokenUsage({ input_tokens: -1, output_tokens: "120" })).toBeUndefined();
  });

  it("keeps reasoning summaries but omits the final structured result from the trace", () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "reasoning", text: "The implementation needs one focused change." }
    }))).toMatchObject({ id: "item_1", phase: "reasoning", text: "The implementation needs one focused change." });
    expect(parseCodexStreamLine(JSON.stringify({
      type: "item.completed",
      item: { id: "item_2", type: "agent_message", text: '{"kind":"agent","text":"Done"}' }
    }))).toBeUndefined();
  });

  it("parses Claude text, tool, and structured result stream events", () => {
    expect(parseClaudeStreamLine(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Inspecting the target" } }
    }))).toMatchObject({ id: "claude-stream-0", phase: "message", text: "Inspecting the target" });
    expect(parseClaudeStreamLine(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "git status" } }] }
    }))).toMatchObject({ id: "tool_1", phase: "tool", title: "Bash", text: "git status" });
    expect(parseClaudeStreamLine(JSON.stringify({
      type: "result",
      subtype: "success",
      structured_output: { kind: "agent", text: "Done" }
    }))).toBeUndefined();
    expect(extractClaudeResult([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", structured_output: { kind: "agent", text: "Done" } })
    ].join("\n"))).toEqual({ kind: "agent", text: "Done" });
  });

  it("keeps interleaved Claude messages separate and replaces their streamed text", () => {
    const messageIds = new Map<string, string>();
    const parse = (event: unknown) => parseClaudeStreamLine(JSON.stringify(event), messageIds);
    const stream = (event: unknown, parent_tool_use_id?: string) => parse({ type: "stream_event", event, parent_tool_use_id });
    stream({ type: "message_start", message: { id: "parent" } });
    stream({ type: "message_start", message: { id: "child" } }, "tool-agent");
    expect(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Parent" } }))
      .toMatchObject({ id: "parent", text: "Parent" });
    expect(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Child" } }, "tool-agent"))
      .toMatchObject({ id: "child", text: "Child" });
    expect(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " text" } }))
      .toMatchObject({ id: "parent", text: " text" });
    stream({ type: "message_stop" });
    expect(parse({ type: "assistant", message: { id: "parent", content: [{ type: "text", text: "Parent text" }] } }))
      .toMatchObject({ id: "parent", text: "Parent text", replace: true, done: true });
    stream({ type: "message_start", message: { id: "next" } });
    expect(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Parent text" } }))
      .toMatchObject({ id: "next", text: "Parent text" });
    expect(parse({ type: "assistant", message: { id: "snapshot-only", content: [{ type: "text", text: "No deltas" }] } }))
      .toMatchObject({ id: "snapshot-only", text: "No deltas", done: true });
  });

  it.each(["api", "conversation"])("deduplicates Claude progress through the %s runner across stdout chunks", async (kind) => {
    const events: AgentStreamEvent[] = [];
    const transcript = [...["first", "second"].flatMap((id) => [
      { type: "stream_event", event: { type: "message_start", message: { id } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Inspecting " } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "files" } } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "assistant", message: { id, content: [{ type: "text", text: "Inspecting files." }] } }
    ]), { type: "result", result: "Done", ...(kind === "api" ? { structured_output: { kind: "ask", text: "Done" } } : {}) }];
    const stdout = transcript.map((event) => JSON.stringify(event)).join("\n");
    const runner = new CliAgentRunner(1_000, async (_command, _args, _input, _cwd, _signal, onStdout) => {
      for (let offset = 0; offset < stdout.length; offset += 37) onStdout?.(stdout.slice(offset, offset + 37));
      return { stdout, stderr: "", code: 0 };
    });
    const profile: AgentProfile = { id: "claude", label: "Claude", provider: "claude", command: process.execPath, models: [] };
    const onEvent = (event: AgentStreamEvent) => events.push(event);
    if (kind === "api") {
      await expect(runner.run({ ...request(), profile, cwd: process.cwd(), onEvent })).resolves.toEqual({ kind: "ask", text: "Done" });
    } else {
      await expect(runner.runConversation({ ...conversationRequest("hello", "claude-dedup"), profile, onEvent }))
        .resolves.toBe("Done");
    }
    // These are the append/replace semantics used by Process and history replay.
    const messages = new Map<string, string>();
    for (const event of events.filter((event) => event.phase === "message")) {
      expect(event.id).toBeDefined();
      messages.set(event.id!, event.replace ? event.text : (messages.get(event.id!) ?? "") + event.text);
    }
    expect([...messages]).toEqual([["first", "Inspecting files."], ["second", "Inspecting files."]]);
    expect(events.filter((event) => event.done)).toHaveLength(2);
  });

  it("uses Claude Code's non-interactive structured streaming flags", () => {
    const args = claudeCliArguments(
      { model: "sonnet", reasoningEffort: "high", permission: "read-only" },
      { type: "object" }
    );
    expect(args).toEqual(expect.arrayContaining([
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--json-schema", JSON.stringify({ type: "object" }), "--no-session-persistence",
      "--permission-mode", "plan", "--model", "sonnet", "--effort", "high"
    ]));
  });

  it.each([["fast", "priority"], ["standard", "default"]])("maps %s speed ahead of a stale Advanced tier for APIs and conversations", async (speed, tier) => {
    const invocations: string[][] = [];
    const runner = new CliAgentRunner(1_000, async (_command, args, _input, _cwd, _signal, onStdout) => {
      if (args[0] === "login") return { stdout: "", stderr: "", code: 1 };
      invocations.push([...args]);
      const text = args.includes("--output-schema") ? JSON.stringify({ kind: "ask", text: "done" }) : "done";
      const stdout = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
      onStdout?.(`${stdout}\n`);
      return { stdout, stderr: "", code: 0 };
    });
    const apiRequest = request();
    apiRequest.profile.command = process.execPath;
    apiRequest.cwd = process.cwd();
    const staleTier = speed === "fast" ? "default" : "priority";
    await runner.run({ ...apiRequest, model: "gpt-test", reasoningEffort: "high", speed, serviceTier: staleTier });
    await runner.runConversation({ ...conversationRequest("test", "speed-test"), speed, serviceTier: staleTier });
    expect(invocations).toHaveLength(2);
    for (const args of invocations) {
      expect(args).toContain(`service_tier="${tier}"`);
      expect(args).not.toContain(`service_tier="${staleTier}"`);
    }
    expect(invocations[0]).toEqual(expect.arrayContaining(["--model", "gpt-test", 'model_reasoning_effort="high"']));
  });

  it("gates the Agent patch instruction on apply and patch", async () => {
    const inputs: string[] = [];
    const runner = new CliAgentRunner(1_000, async (_command, args, input) => {
      if (args[0] !== "login") inputs.push(input);
      return {
        stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
        stderr: "",
        code: 0
      };
    });
    const method: RegisteredCallable = {
      ...BUILTIN_METHODS.find((candidate) => candidate.id === "agent")!,
      source: "builtin"
    };
    const base: AgentExecutionRequest = {
      ...request(),
      profile: { id: "codex", label: "Codex", provider: "codex", command: process.execPath, models: [] },
      cwd: process.cwd(),
      method,
      contract: new AxAdapter().compile(method),
      resolved: {
        ...request().resolved,
        invocation: { kind: "invocation", method: "agent", arguments: [{ name: "input", value: "hello" }], source: "code" },
        method,
        arguments: { input: "hello" }
      }
    };

    await runner.run({ ...base, allowWorkspaceWrite: true });
    await runner.run({ ...base, allowWorkspaceWrite: true, includePatch: false });
    await runner.run({ ...base, allowWorkspaceWrite: false });
    await runner.run({ ...base, allowWorkspaceWrite: false, includePatch: false });

    expect(inputs[0]).toContain("including an auditable patch whenever changes can be represented");
    expect(inputs[1]).toContain("without a patch; report conclusions in text only");
    expect(inputs[1]).not.toContain("auditable patch");
    expect(inputs[2]).toContain("include a complete applicable patch with exact before and after content");
    expect(inputs[3]).toContain("without a patch; report conclusions in text only");
    expect(inputs[3]).not.toContain("complete applicable patch");
  });

  it("uses normal provider prompts without an output schema for conversations", () => {
    expect(codexConversationArguments({ permission: "workspace-write" }, "priority"))
      .toEqual(expect.arrayContaining(["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check"]));
    expect(codexConversationArguments({ permission: "read-only" }))
      .toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
    expect(codexConversationArguments({ permission: "read-only" })).not.toContain("--output-schema");
    expect(codexConversationArguments({ permission: "read-only" })).not.toContain("--skip-git-repo-check");
    expect(claudeConversationArguments({ permission: "read-only" }))
      .toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(claudeConversationArguments({ permission: "workspace-write" })).not.toContain("--json-schema");
  });

  it("uses native fork arguments for Codex and Claude sessions", () => {
    expect(codexConversationArguments({ permission: "read-only" }, undefined, [], {
      persist: true,
      forkFromId: "codex-source"
    }).slice(-3)).toEqual(["fork", "codex-source", "-"]);
    expect(claudeConversationArguments({
      permission: "read-only",
      resumeId: "claude-source",
      forkSession: true
    })).toEqual(expect.arrayContaining(["--resume", "claude-source", "--fork-session"]));
    expect(claudeConversationArguments({ permission: "read-only" })).not.toContain("--no-session-persistence");
  });

  it("persists the first Codex conversation turn and resumes its exact thread", () => {
    const initial = codexConversationArguments(
      { model: "gpt-5", permission: "read-only" },
      undefined,
      [],
      { persist: true }
    );
    expect(initial).not.toContain("--ephemeral");
    expect(initial).not.toContain("resume");

    const resumed = codexConversationArguments(
      { model: "gpt-5", permission: "read-only" },
      undefined,
      [],
      { persist: true, resumeId: "019c1234-5678-7000-8000-000000000000" }
    );
    expect(resumed.slice(-3)).toEqual([
      "resume", "019c1234-5678-7000-8000-000000000000", "-"
    ]);
    expect(resumed).not.toContain("--ephemeral");
  });

  it("extracts the resumable Codex thread ID without rendering it as progress", () => {
    const started = JSON.stringify({
      type: "thread.started",
      thread_id: "019c1234-5678-7000-8000-000000000000"
    });
    expect(extractCodexThreadId(`${started}\n${JSON.stringify({ type: "turn.started" })}`))
      .toBe("019c1234-5678-7000-8000-000000000000");
    expect(parseCodexStreamLine(started)).toBeUndefined();
  });

  it("resumes the Codex thread bound to the same Dext conversation only", async () => {
    const invocations: string[][] = [];
    let nextThread = 1;
    const runner = new CliAgentRunner(1_000, async (_command, args, _input, _cwd, _signal, onStdout) => {
      if (args[0] === "login") return { stdout: "", stderr: "", code: 1 };
      invocations.push([...args]);
      const resumedAt = args.indexOf("resume");
      const threadId = resumedAt === -1 ? `thread-${nextThread++}` : args[resumedAt + 1]!;
      const stdout = [
        JSON.stringify({ type: "thread.started", thread_id: threadId }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `reply from ${threadId}` } })
      ].join("\n");
      onStdout?.(`${stdout}\n`);
      return { stdout, stderr: "", code: 0 };
    });

    await expect(runner.runConversation(conversationRequest("first", "chat-a")))
      .resolves.toBe("reply from thread-1");
    await expect(runner.runConversation(conversationRequest("second", "chat-a")))
      .resolves.toBe("reply from thread-1");
    await expect(runner.runConversation(conversationRequest("other", "chat-b")))
      .resolves.toBe("reply from thread-2");

    expect(invocations[0]).not.toContain("resume");
    expect(invocations[0]).not.toContain("--ephemeral");
    expect(invocations[1]?.slice(-3)).toEqual(["resume", "thread-1", "-"]);
    expect(invocations[2]).not.toContain("resume");
  });

  it("bootstraps a new Codex thread with copied conversation context", async () => {
    const inputs: string[] = [];
    const runner = new CliAgentRunner(1_000, async (_command, args, input, _cwd, _signal, onStdout) => {
      if (args[0] !== "login") inputs.push(input);
      const threadId = args.includes("resume") ? "thread-existing" : "thread-new";
      const stdout = [
        JSON.stringify({ type: "thread.started", thread_id: threadId }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } })
      ].join("\n");
      onStdout?.(`${stdout}\n`);
      return { stdout, stderr: "", code: 0 };
    });
    const first = conversationRequest("continue", "fork-session");
    first.metadata = { ...first.metadata, conversationContext: "User: prior\nAssistant: answer" };
    await runner.runConversation(first);
    expect(inputs[0]).toContain("User: prior");
    expect(inputs[0]).toContain("New user message:\ncontinue");

    const second = conversationRequest("next", "fork-session");
    second.metadata = { ...second.metadata, conversationContext: "User: prior\nAssistant: answer" };
    await runner.runConversation(second);
    expect(inputs[1]).toBe("next");
  });

  it("bootstraps Claude conversations from Dext context", async () => {
    const inputs: string[] = [];
    const request = conversationRequest("continue", "claude-session");
    request.profile = { ...request.profile, id: "claude", label: "Claude", provider: "claude" };
    request.metadata = { ...request.metadata, conversationContext: "User: prior\nAssistant: answer" };
    const runner = new CliAgentRunner(1_000, async (_command, _args, input) => {
      inputs.push(input);
      const stdout = JSON.stringify({ type: "result", result: "ok" });
      return { stdout, stderr: "", code: 0 };
    });
    await runner.runConversation(request);
    expect(inputs[0]).toContain("User: prior");
    expect(inputs[0]).toContain("New user message:\ncontinue");
  });

  it("maps each permission tier onto the flag its provider understands", () => {
    expect(claudePermissionMode("read-only")).toBe("plan");
    expect(claudePermissionMode("workspace-write")).toBe("acceptEdits");
    expect(claudePermissionMode("full-access")).toBe("bypassPermissions");
    expect(codexSandbox("read-only")).toBe("read-only");
    expect(codexSandbox("workspace-write")).toBe("workspace-write");
    expect(codexSandbox("full-access")).toBe("danger-full-access");
    // Full access still needs the git check skipped, exactly like a write turn.
    expect(codexConversationArguments({ permission: "full-access" }))
      .toEqual(expect.arrayContaining(["--sandbox", "danger-full-access", "--skip-git-repo-check"]));
    expect(claudeConversationArguments({ permission: "full-access" }))
      .toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
    // The apply flag remains the hard gate, while an explicit composer tier
    // can now reach the provider's top sandbox.
    expect(permissionForWrite(true)).toBe("workspace-write");
    expect(permissionForWrite(true, "full-access")).toBe("full-access");
    expect(permissionForWrite(true, "read-only")).toBe("workspace-write");
    expect(permissionForWrite(false, "full-access")).toBe("read-only");
    expect(permissionForWrite(false)).toBe("read-only");
    expect(permissionForWrite(undefined)).toBe("read-only");
  });

  it("appends passthrough CLI arguments after Dext's own and before Codex's stdin marker", () => {
    const codex = codexConversationArguments(
      { permission: "workspace-write" },
      undefined,
      ["--config", 'sandbox_workspace_write.network_access=true']
    );
    expect(codex.slice(-3)).toEqual([
      "--config", 'sandbox_workspace_write.network_access=true', "-"
    ]);
    // A passthrough argument must never be able to displace the sandbox flag.
    expect(codex.indexOf("--sandbox")).toBeLessThan(codex.indexOf("sandbox_workspace_write.network_access=true"));
    const claude = claudeConversationArguments({ permission: "read-only" }, ["--add-dir", "/tmp/scratch"]);
    expect(claude.slice(-2)).toEqual(["--add-dir", "/tmp/scratch"]);
    expect(claude.indexOf("--permission-mode")).toBeLessThan(claude.indexOf("--add-dir"));
    const structured = codexCliArguments({}, "output-schema.json", "read-only", undefined, ["--profile", "audit"]);
    expect(structured.slice(-3)).toEqual(["--profile", "audit", "-"]);
  });

  it("keeps ordinary conversation replies as raw text", () => {
    const text = '{"kind":"ask","text":"this is ordinary model text"}';
    expect(extractConversationText(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text }
    }), "codex")).toBe(text);
  });

  it("opens workspace writes only for an explicit agent apply request", () => {
    expect(codexCliArguments({}, "output-schema.json", "read-only")).toEqual(expect.arrayContaining([
      "--sandbox", "read-only"
    ]));
    expect(codexCliArguments({}, "output-schema.json", "workspace-write")).toEqual(expect.arrayContaining([
      "--sandbox", "workspace-write", "--skip-git-repo-check"
    ]));
    expect(codexCliArguments({}, "output-schema.json", "full-access")).toEqual(expect.arrayContaining([
      "--sandbox", "danger-full-access", "--skip-git-repo-check"
    ]));
    expect(claudeCliArguments({ permission: "workspace-write" }, { type: "object" }))
      .toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
  });

  it("keeps schemas in native CLI flags instead of duplicating them in the stdin payload", () => {
    const payload = JSON.parse(agentPayload(request())) as Record<string, unknown>;
    expect(payload).toEqual({
      api: "ask",
      description: "Hold a read-only conversation about a string input with optional inline Dext references.",
      arguments: { input: "Hello" },
      context: []
    });
    expect(payload).not.toHaveProperty("output_schema");
    expect(codexCliArguments({ model: "gpt-5", reasoningEffort: "high" }, "output-schema.json", "read-only", "priority"))
      .toEqual(expect.arrayContaining([
        "--ephemeral", "--sandbox", "read-only", "--output-schema", "output-schema.json",
        "--model", "gpt-5", "--config", 'model_reasoning_effort="high"',
        "--config", 'service_tier="priority"'
      ]));
  });

  it("passes readable @ input directly to an Agent adapter", () => {
    const value = request();
    value.resolved.arguments.input = "Read @src/a.ts then @docs";
    expect(JSON.parse(agentPayload(value))).toMatchObject({
      arguments: { input: "Read @src/a.ts then @docs" }
    });
    expect(JSON.parse(agentPayload(value))).not.toHaveProperty("inputContext");
  });

  it("makes optional output fields nullable while requiring every Codex object property", () => {
    const method = BUILTIN_METHODS.find((candidate) => candidate.id === "agent")!;
    const schema = codexOutputSchema(new AxAdapter().compile(method).outputJsonSchema) as {
      required: string[];
      properties: { files: { items: { required: string[]; properties: { range: { type: string[] } } } } };
    };
    expect(schema.required).toEqual(["kind", "text", "summary", "patch", "files"]);
    expect(schema.properties.files.items.required).toContain("range");
    expect(schema.properties.files.items.properties.range.type).toEqual(["object", "null"]);
  });

  it("resolves a Windows command shim from PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-agent-test-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "codex.cmd"), "@echo off", "utf8");

    expect(resolveCliCommand("codex", "codex", {
      platform: "win32",
      env: { Path: directory, PATHEXT: ".CMD;.EXE" },
    })).toBe(join(directory, "codex.cmd"));
  });


  it("returns no command when Codex is not on PATH", () => {
    expect(resolveCliCommand("codex", "codex", {
      platform: "win32", env: { Path: "", CODEX_CLI_PATH: "C:\\stale\\codex.exe" }
    })).toBeUndefined();
  });

  it("returns no command when Claude is not on PATH", () => {
    expect(resolveCliCommand("claude", "claude", { platform: "win32", env: { Path: "" } })).toBeUndefined();
  });

  it("returns no command when a non-Windows CLI is not on PATH", () => {
    expect(resolveCliCommand("codex", "codex", { platform: "linux", env: {} })).toBeUndefined();
  });

  it("resolves a non-Windows CLI from PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-agent-unix-test-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "codex"), "#!/bin/sh", "utf8");

    expect(resolveCliCommand("codex", "codex", { platform: "linux", env: { PATH: directory } })).toBe(join(directory, "codex"));
  });

  it("terminates a running CLI process when its execution signal is aborted", async () => {
    const controller = new AbortController();
    const running = runProcess(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      "",
      process.cwd(),
      controller.signal
    );
    setTimeout(() => controller.abort(), 25);

    await expect(running).rejects.toMatchObject({ name: "ExecutionCancelledError" });
  });

  it.each(["stdout", "stderr"])("counts %s output as activity even without a rendered event", async (stream) => {
    const activity = vi.fn();
    const result = await runProcess(process.execPath,
      ["-e", `process.${stream}.write('partial output')`], "", process.cwd(),
      undefined, undefined, undefined, undefined, activity);
    expect(result[stream as "stdout" | "stderr"]).toBe("partial output");
    expect(activity).toHaveBeenCalled();
  });

  it.each(["conversation", "api"])("keeps an active %s and its silent tools running beyond the idle interval", async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let activity!: () => void;
    let emit!: (chunk: string) => void;
    let finish!: () => void;
    let executionSignal: AbortSignal | undefined;
    const runner = new CliAgentRunner(0, async (_command, args, _input, _cwd, signal, onStdout, _env, _completion, onActivity) => {
      if (args[0] === "login") return { stdout: "", stderr: "", code: 1 };
      executionSignal = signal;
      activity = onActivity!;
      emit = onStdout!;
      await new Promise<void>((resolve) => { finish = resolve; started(); });
      return { stdout: JSON.stringify({ type: "item.completed", item: {
        type: "agent_message", text: kind === "api" ? JSON.stringify({ kind: "ask", text: "done" }) : "done"
      } }), stderr: "", code: 0 };
    }, 1000);
    try {
      const req = request();
      req.profile.command = process.execPath;
      req.cwd = process.cwd();
      const result = kind === "api" ? runner.run(req) : runner.runConversation(conversationRequest("hello", "timeout-test"));
      await ready;
      for (let index = 0; index < 6; index++) {
        vi.advanceTimersByTime(750);
        activity();
        expect(executionSignal?.aborted).toBe(false);
      }
      emit('{"type":"item.started","item":');
      emit('{"id":"command","type":"command_execution"}}\n');
      vi.advanceTimersByTime(5000);
      expect(executionSignal?.aborted).toBe(false);
      emit('{"type":"item.completed","item":{"id":"command","type":"command_execution","aggregated_output":""}}\n');
      vi.advanceTimersByTime(999);
      expect(executionSignal?.aborted).toBe(false);
      finish();
      expect(await result).toEqual(kind === "api" ? JSON.stringify({ kind: "ask", text: "done" }) : "done");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("native structured output", () => {
  const projectSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      note: { type: "string" },
      nodes: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] } }
    },
    required: ["title"]
  };

  function structuredRequest(overrides: Partial<AgentStructuredRequest> = {}): AgentStructuredRequest {
    return {
      profile: { id: "codex", label: "Codex", provider: "codex", command: process.execPath, models: [] },
      cwd: process.cwd(),
      input: "Generate the project model.",
      outputSchema: projectSchema,
      ...overrides
    };
  }

  it("carries the schema through Codex's own output-schema channel and makes optionals nullable", async () => {
    let schemaDocument = "";
    let stdin = "";
    let args: readonly string[] = [];
    const runner = new CliAgentRunner(1_000, async (_command, received, input) => {
      if (received[0] === "login") return { stdout: "", stderr: "", code: 1 };
      args = received;
      stdin = input;
      schemaDocument = await readFile(received[received.indexOf("--output-schema") + 1]!, "utf8");
      const text = JSON.stringify({ title: "One", note: null, nodes: [{ id: "n1" }] });
      return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }), stderr: "", code: 0 };
    });

    const text = await runner.runStructured(structuredRequest());

    // The prompt reaches the CLI unchanged: the schema travels out of band.
    expect(stdin).toBe("Generate the project model.");
    expect(args).toContain("--output-schema");
    // Codex strict structured output requires every object property, so the
    // optional ones are sent required-but-nullable.
    const schema = JSON.parse(schemaDocument) as { required: string[]; properties: Record<string, { type: unknown }> };
    expect(schema.required).toEqual(["title", "note", "nodes"]);
    expect(schema.properties.note!.type).toEqual(["string", "null"]);
    expect(schema.properties.nodes!.type).toEqual(["array", "null"]);
    // ...and the null the model answers with is restored to "absent" for zod.
    expect(JSON.parse(text)).toEqual({ title: "One", nodes: [{ id: "n1" }] });
  });

  it("sends Claude the schema unchanged and normalizes its structured_output", async () => {
    let args: readonly string[] = [];
    const runner = new CliAgentRunner(1_000, async (_command, received) => {
      args = received;
      return {
        stdout: `${JSON.stringify({ type: "result", subtype: "success", structured_output: { title: "Two", note: null } })}\n`,
        stderr: "",
        code: 0
      };
    });

    const text = await runner.runStructured(structuredRequest({
      profile: { id: "claude", label: "Claude Code", provider: "claude", command: process.execPath, models: [] }
    }));

    expect(args).toContain("--json-schema");
    expect(args[args.indexOf("--json-schema") + 1]).toBe(JSON.stringify(projectSchema));
    // Claude is not told every property is required, so the schema document is
    // the caller's; only the answer is normalized.
    expect(JSON.parse(text)).toEqual({ title: "Two" });
  });

  it("passes the model, reasoning effort and speed tier to the provider", async () => {
    let args: readonly string[] = [];
    const runner = new CliAgentRunner(1_000, async (_command, received) => {
      if (received[0] === "login") return { stdout: "", stderr: "", code: 1 };
      args = received;
      return {
        stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ title: "T" }) } }),
        stderr: "", code: 0
      };
    });
    await runner.runStructured(structuredRequest({ model: "gpt-test", reasoningEffort: "high", speed: "fast" }));
    expect(args).toEqual(expect.arrayContaining(["--model", "gpt-test", 'model_reasoning_effort="high"', "--config", 'service_tier="priority"']));
  });

  it("reports a provider that fails as a provider failure, not as an invalid answer", async () => {
    const runner = new CliAgentRunner(1_000, async (_command, args) => {
      if (args[0] === "login") return { stdout: "", stderr: "", code: 1 };
      return { stdout: "", stderr: "Unknown schema keyword: $schema", code: 2 };
    });
    await expect(runner.runStructured(structuredRequest())).rejects.toThrow(/Codex exited with code 2[\s\S]*Unknown schema keyword/);
  });

  it("refuses a provider that has no native output-schema channel", async () => {
    const runner = new CliAgentRunner(1_000, async () => ({ stdout: "", stderr: "", code: 0 }));
    await expect(runner.runStructured(structuredRequest({
      profile: { id: "deepseek-harness", label: "DeepSeek Harness", provider: "deepseek-harness", command: process.execPath, models: [] }
    }))).rejects.toThrow(/native structured output/);
  });
});

