import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentPayload,
  agentProcessEnvironment,
  claudeCliArguments,
  codexCliArguments,
  codexOutputSchema,
  extractClaudeResult,
  parseClaudeStreamLine,
  parseCodexStreamLine,
  resolveCliCommand,
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
    ...BUILTIN_METHODS.find((candidate) => candidate.id === "chat")!,
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
      invocation: { kind: "invocation", method: "chat", arguments: [{ name: "message", value: "Hello" }], source: "chat" },
      method,
      arguments: { message: "Hello" },
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
    const args = claudeCliArguments({ model: "sonnet", reasoningEffort: "high" }, { type: "object" });
    expect(args).toEqual(expect.arrayContaining([
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--json-schema", JSON.stringify({ type: "object" }), "--no-session-persistence",
      "--permission-mode", "plan", "--model", "sonnet", "--effort", "high"
    ]));
  });

  it("keeps schemas in native CLI flags instead of duplicating them in the stdin payload", () => {
    const payload = JSON.parse(agentPayload(request())) as Record<string, unknown>;
    expect(payload).toEqual({
      api: "chat",
      description: "Return a typed response for an explicit natural-language instruction.",
      arguments: { message: "Hello" },
      context: []
    });
    expect(payload).not.toHaveProperty("output_schema");
    expect(codexCliArguments({ model: "gpt-5", reasoningEffort: "high" }, "output-schema.json", false, "priority"))
      .toEqual(expect.arrayContaining([
        "--ephemeral", "--sandbox", "read-only", "--output-schema", "output-schema.json",
        "--model", "gpt-5", "--config", 'model_reasoning_effort="high"',
        "--config", 'service_tier="priority"'
      ]));
  });

  it("makes optional output fields nullable while requiring every Codex object property", () => {
    const method = BUILTIN_METHODS.find((candidate) => candidate.id === "code.explain")!;
    const schema = codexOutputSchema(new AxAdapter().compile(method).outputJsonSchema) as {
      required: string[];
      properties: { files: { items: { required: string[]; properties: { range: { type: string[] } } } } };
    };
    expect(schema.required).toEqual(["kind", "text", "files"]);
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
});
