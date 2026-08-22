import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedInvocation } from "../src/core/types.js";
import type { DeterministicHandler } from "../src/core/runtime.js";

const vscodeState = vi.hoisted(() => ({
  trusted: true,
  defaultTimeoutMs: undefined as number | undefined
}));

vi.mock("vscode", () => ({
  workspace: {
    get isTrusted() { return vscodeState.trusted; },
    get workspaceFolders() {
      return [{ uri: { scheme: "file", fsPath: process.cwd() } }];
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
    ({ terminalRunHandler } = await import("../src/vscodeTerminalHost.js"));
  });
  beforeEach(() => {
    vscodeState.trusted = true;
    vscodeState.defaultTimeoutMs = undefined;
  });

  it("describes itself as running without a confirmation step, which is what it does", async () => {
    const { BUILTIN_METHODS } = await import("../src/core/builtins.js");
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
      cwd: resolve(process.cwd()),
      exit_code: 0,
      stderr: ""
    });
    expect(result.kind === "terminal" && result.stdout.trim()).toMatch(/^v\d+/);
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
