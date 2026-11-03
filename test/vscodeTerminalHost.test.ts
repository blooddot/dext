import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedInvocation } from "../src/shared/contracts/types.js";
import type { DeterministicHandler } from "../src/features/workflow/host/runtime.js";

const vscodeState = vi.hoisted(() => ({
  trusted: true,
  defaultTimeoutMs: undefined as number | undefined,
  root: undefined as string | undefined
}));

vi.mock("vscode", () => ({
  workspace: {
    get isTrusted() { return vscodeState.trusted; },
    get workspaceFolders() {
      return [{ uri: { scheme: "file", fsPath: vscodeState.root ?? process.cwd() } }];
    },
    getConfiguration: () => ({
      get: (_key: string, fallback: unknown) => vscodeState.defaultTimeoutMs ?? fallback
    })
  },
  window: {}
}));

let terminalRunHandler: DeterministicHandler;

function invocation(arguments_: ResolvedInvocation["arguments"]): ResolvedInvocation {
  return {
    invocation: { kind: "invocation", method: "terminal", arguments: [], source: "code" },
    method: {
      id: "terminal",
      title: "Run",
      description: "Run",
      kind: "command",
      version: "1.0.0",
      input: [],
      output: { kind: "terminal" },
      executor: { kind: "deterministic", handler: "terminalRun" },
      source: "builtin"
    },
    arguments: arguments_,
    context: [],
    metadata: {}
  };
}

describe("VS Code terminal host", () => {
  beforeAll(async () => {
    ({ terminalRunHandler } = await import("../src/platform/vscode/terminalHost.js"));
  });
  beforeEach(() => {
    vscodeState.trusted = true;
    vscodeState.defaultTimeoutMs = undefined;
    vscodeState.root = undefined;
  });

  it("describes itself as running without a confirmation step, which is what it does", async () => {
    const { BUILTIN_METHODS } = await import("../src/features/workflow/domain/builtins.js");
    const terminal = BUILTIN_METHODS.find((method) => method.id === "terminal");
    // The old wording promised a confirmation the handler never performs.
    expect(terminal?.description).not.toContain("confirmed command");
    expect(terminal?.description).toContain("without a confirmation prompt");
  });

  it("requires a trusted workspace and rejects cwd traversal", async () => {
    vscodeState.trusted = false;
    await expect(terminalRunHandler(invocation({ command: "node --version" })))
      .rejects.toThrow("trusted workspace");
    vscodeState.trusted = true;
    await expect(terminalRunHandler(invocation({ command: "node --version", cwd: ".." })))
      .rejects.toThrow("inside the current workspace");
  });

  it("runs through the platform shell and returns a fixed result", async () => {
    const result = await terminalRunHandler(invocation({ command: "node --version" }));
    expect(result).toMatchObject({
      kind: "terminal",
      status: "succeeded",
      command: "node --version",
      cwd: realpathSync.native(resolve(process.cwd())),
      exit_code: 0,
      stderr: ""
    });
    expect(result.kind === "terminal" && result.stdout.trim()).toMatch(/^v\d+/);
  });

  it("hands the shell the on-disk spelling of the workspace path", async () => {
    // VS Code reports the folder from a file URI, which keeps the drive-letter
    // case the workspace was opened with (`c:\repo`). Vite keys its module graph
    // by path, so that spelling made every test file load a second copy of
    // @vitest/runner and fail before running. The spawned cwd has to be canonical.
    const root = mkdtempSync(join(tmpdir(), "dext-terminal-"));
    const lowercase = process.platform === "win32" ? `${root.charAt(0).toLowerCase()}${root.slice(1)}` : root;
    vscodeState.root = lowercase;
    try {
      const result = await terminalRunHandler(invocation({ command: "node --version" }));
      expect(result).toMatchObject({ kind: "terminal", status: "succeeded", cwd: realpathSync.native(root) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nonzero exits and enforces timeout bounds", async () => {
    const failed = await terminalRunHandler(invocation({
      command: 'node -e "process.exit(7)"',
      timeout_ms: 5_000
    }));
    expect(failed).toMatchObject({ kind: "terminal", status: "failed", exit_code: 7 });
    await expect(terminalRunHandler(invocation({ command: "node --version", timeout_ms: 600_001 })))
      .rejects.toThrow("from 1 to 600000");
  });

  it("uses the manifest default, accepts its ceiling, and falls back for invalid settings", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      contributes: { configuration: { properties: { "dext.terminal.defaultTimeoutMs": { default: number; maximum: number } } } };
    };
    const setting = manifest.contributes.configuration.properties["dext.terminal.defaultTimeoutMs"];
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      for (const [configured, expected] of [
        [undefined, setting.default], [setting.default, setting.default],
        [setting.maximum, setting.maximum], [setting.maximum + 1, setting.default],
        [0, setting.default], [-1, setting.default], [1.5, setting.default]
      ]) {
        timer.mockClear();
        vscodeState.defaultTimeoutMs = configured;
        const result = await terminalRunHandler(invocation({ command: "node --version" }));
        expect(result).toMatchObject({ status: "succeeded" });
        expect(timer).toHaveBeenCalledWith(expect.any(Function), expected);
      }
    } finally {
      timer.mockRestore();
    }
  });

  it("answers with timed_out even when the command ignores the termination signal", { timeout: 20_000 }, async () => {
    const result = await terminalRunHandler(invocation({
      command: `"${process.execPath}" -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`,
      timeout_ms: 100
    }));
    // Waiting only for `close` left this pending forever on a command that keeps
    // its SIGTERM handler.
    expect(result).toMatchObject({ kind: "terminal", status: "timed_out", exit_code: -1 });
  });

  it("never cuts a multi-byte character at the output limit", { timeout: 30_000 }, async () => {
    const script = "process.stdout.write('a'.repeat(262143)); process.stdout.write(Buffer.from([0xe4, 0xb8, 0xad]));";
    const result = await terminalRunHandler(invocation({
      command: `"${process.execPath}" -e "${script}"`,
      timeout_ms: 60_000
    }));
    const stdout = result.kind === "terminal" ? result.stdout : "";
    expect(stdout).not.toContain("\uFFFD");
    expect(stdout.endsWith("[output truncated]")).toBe(true);
  });

  it("takes its default timeout from settings but never past the hard ceiling", async () => {
    vscodeState.defaultTimeoutMs = 50;
    const timedOut = await terminalRunHandler(invocation({
      command: 'node -e "setTimeout(() => {}, 5000)"'
    }));
    expect(timedOut).toMatchObject({ kind: "terminal", status: "timed_out", exit_code: -1 });
    // A configured value above MAX_TIMEOUT_MS is a mistake, so the built-in
    // default is used rather than letting a runaway command live longer.
    vscodeState.defaultTimeoutMs = 600_001;
    const ran = await terminalRunHandler(invocation({ command: "node --version" }));
    expect(ran).toMatchObject({ kind: "terminal", status: "succeeded" });
  });
});
