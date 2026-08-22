import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentPayload,
  agentProcessEnvironment,
  claudeConversationArguments,
  claudeCliArguments,
  claudePermissionMode,
  codexConversationArguments,
  codexCliArguments,
  codexOutputSchema,
  codexSandbox,
  permissionForWrite,
  extractConversationText,
  extractClaudeResult,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  resolveCliCommand,
  runProcess,
  type AgentExecutionRequest
} from "../src/core/agentRunner.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { AxAdapter } from "../src/core/axAdapter.js";
import { serializeResultForAgent } from "../src/core/resultSerialization.js";
import type { AgentProfile } from "../src/agentProfiles.js";
import type { RegisteredCallable } from "../src/core/types.js";

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
    expect(serializeResultForAgent({ kind: "chat", text: "hello" } as const)).toEqual({
      kind: "dext-result",
      version: 1,
      result_kind: "chat",
      value: { kind: "chat", text: "hello" }
    });
  });

  it("keeps Codex progress messages in the visible agent trace", () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "I will inspect the target first." }
    }))).toMatchObject({ id: "item_0", phase: "message", text: "I will inspect the target first.", done: true });
  });

  it("keeps reasoning summaries but omits the final structured result from the trace", () => {
    expect(parseCodexStreamLine(JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "reasoning", text: "The implementation needs one focused change." }
    }))).toMatchObject({ id: "item_1", phase: "reasoning", text: "The implementation needs one focused change." });
    expect(parseCodexStreamLine(JSON.stringify({
      type: "item.completed",
      item: { id: "item_2", type: "agent_message", text: '{"kind":"explain","text":"Done","files":[]}' }
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
      structured_output: { kind: "explain", text: "Done", files: [] }
    }))).toBeUndefined();
    expect(extractClaudeResult([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } }),
      JSON.stringify({ type: "result", subtype: "success", structured_output: { kind: "explain", text: "Done", files: [] } })
    ].join("\n"))).toEqual({ kind: "explain", text: "Done", files: [] });
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
    // The DSL only ever knows about writing or not, so it can never reach the
    // top tier however the composer is configured.
    expect(permissionForWrite(true)).toBe("workspace-write");
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
    const text = '{"kind":"chat","text":"this is ordinary model text"}';
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
      home: directory
    })).toBe(join(directory, "codex.cmd"));
  });

  it("finds the Codex desktop CLI under CODEX_HOME when PATH is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-codex-test-"));
    temporaryDirectories.push(directory);
    const bin = join(directory, ".sandbox-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "codex.exe"), "binary", "utf8");

    expect(resolveCliCommand("codex", "codex", {
      platform: "win32",
      env: { CODEX_HOME: directory, Path: "" },
      home: directory
    })).toBe(join(bin, "codex.exe"));
  });

  it("prefers CODEX_CLI_PATH from the Codex config over an older sandbox binary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-codex-config-test-"));
    temporaryDirectories.push(directory);
    const configured = join(directory, "codex.exe");
    await writeFile(configured, "binary", "utf8");
    await writeFile(join(directory, "config.toml"), `CODEX_CLI_PATH = '${configured.replace(/\\/g, "\\\\")}'\n`, "utf8");

    expect(resolveCliCommand("codex", "codex", {
      platform: "win32",
      env: { CODEX_HOME: directory, Path: "" },
      home: directory
    })).toBe(configured);
  });

  it("finds Claude Code's native Windows installation when PATH is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-claude-test-"));
    temporaryDirectories.push(directory);
    const bin = join(directory, ".local", "bin");
    await mkdir(bin, { recursive: true });
    const executable = join(bin, "claude.exe");
    await writeFile(executable, "binary", "utf8");

    expect(resolveCliCommand("claude", "claude", {
      platform: "win32",
      env: { Path: "" },
      home: directory
    })).toBe(executable);
  });

  it("returns a configured non-Windows command without probing the local filesystem", () => {
    expect(resolveCliCommand("codex", "codex", { platform: "linux", env: {}, home: "/tmp" })).toBe("codex");
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
});
