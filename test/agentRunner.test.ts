import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentProcessEnvironment, codexOutputSchema, resolveCliCommand } from "../src/core/agentRunner.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { AxAdapter } from "../src/core/axAdapter.js";
import { serializeResultForAgent } from "../src/core/resultSerialization.js";

const temporaryDirectories: string[] = [];

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

  it("returns a configured non-Windows command without probing the local filesystem", () => {
    expect(resolveCliCommand("codex", "codex", { platform: "linux", env: {}, home: "/tmp" })).toBe("codex");
  });
});
