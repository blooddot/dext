import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isAbsolute, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import type { DeterministicHandler } from "../../features/workflow/contracts/runtime.js";
import type { TerminalResult } from "../../shared/contracts/types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
/** A command that ignores SIGTERM must not keep the run waiting for a `close`
 * that never comes: escalate to SIGKILL, then answer anyway. */
const KILL_ESCALATION_MS = 3_000;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`terminal requires a nonempty '${name}'.`);
  }
  return value;
}

/** MAX_TIMEOUT_MS stays a hard ceiling: a configured value above it is a
 * mistake, not a request to let a runaway command live longer. */
function configuredDefaultTimeout(): number {
  const value = vscode.workspace
    .getConfiguration("dext")
    .get<number>("terminal.defaultTimeoutMs", DEFAULT_TIMEOUT_MS);
  return Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS ? value : DEFAULT_TIMEOUT_MS;
}

function timeoutValue(value: unknown): number {
  const timeout = value === undefined ? configuredDefaultTimeout() : value;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`terminal timeout_ms must be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
  }
  return timeout;
}

function environmentValue(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("terminal env must be an object of string values.");
  }
  const environment: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`terminal env has an invalid variable name: ${name}.`);
    if (typeof entry !== "string") throw new Error(`terminal env '${name}' must be a string.`);
    environment[name] = entry;
  }
  return environment;
}

function trustedWorkspaceRoot(): string {
  if (!vscode.workspace.isTrusted) {
    throw new Error("terminal requires a trusted workspace.");
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length || folders.some((folder) => folder.uri.scheme !== "file")) {
    throw new Error("terminal requires a local file workspace.");
  }
  return folders[0]!.uri.fsPath;
}

function workspaceCwd(root: string, value: unknown): string {
  const requested = value === undefined ? "." : requiredString(value, "cwd");
  const realRoot = realpathSync(root);
  const cwd = realpathSync(resolve(realRoot, requested));
  const pathFromRoot = relative(realRoot, cwd);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..\\`) || pathFromRoot.startsWith("../")) {
    throw new Error("terminal cwd must stay inside the current workspace.");
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error("terminal cwd must be a directory.");
  }
  return cwd;
}

function appendLimited(current: string, chunk: Buffer, decoder: StringDecoder): string {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  // The decoder holds an incomplete multi-byte character back instead of
  // emitting U+FFFD where the byte budget cuts one in half.
  const value = decoder.write(chunk.subarray(0, remaining));
  return chunk.length > remaining ? `${current}${value}\n[output truncated]` : current + value;
}

function execute(command: string, cwd: string, timeoutMs: number, environmentOverrides: Readonly<Record<string, string>>): Promise<TerminalResult> {
  return new Promise((complete, reject) => {
    const started = performance.now();
    const environment = {
      ...process.env,
      TERM: process.env.TERM ?? "xterm-256color",
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      CLICOLOR_FORCE: process.env.CLICOLOR_FORCE ?? "1",
      GIT_PAGER: "cat",
      ...environmentOverrides,
      ...( /^\s*git(?:\s|$)/i.test(command)
        ? {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "color.ui",
            GIT_CONFIG_VALUE_0: "always"
          }
        : {})
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const terminate = (force: boolean) => {
      if (!child.pid) {
        child.kill();
        return;
      }
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore"
        });
        return;
      }
      try {
        // `detached` above makes the child a process-group leader, so this also
        // reaches the commands it started.
        process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      } catch {
        child.kill(force ? "SIGKILL" : "SIGTERM");
      }
    };
    /** Ends the call once, and stops both timers with it. */
    const release = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      return true;
    };
    const finish = (code: number | null) => {
      if (!release()) return;
      const exitCode = timedOut ? -1 : (code ?? -1);
      complete({
        kind: "terminal",
        status: timedOut ? "timed_out" : exitCode === 0 ? "succeeded" : "failed",
        command,
        cwd,
        exit_code: exitCode,
        stdout,
        stderr,
        duration_ms: performance.now() - started
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(false);
      escalation = setTimeout(() => {
        terminate(true);
        finish(null);
      }, KILL_ESCALATION_MS);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = appendLimited(stdout, chunk, stdoutDecoder); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendLimited(stderr, chunk, stderrDecoder); });
    child.on("error", (error) => {
      if (release()) reject(error);
    });
    child.on("close", (code) => finish(code));
  });
}

export const terminalRunHandler: DeterministicHandler = async ({ arguments: args }) => {
  const command = requiredString(args.command, "command");
  const root = trustedWorkspaceRoot();
  const cwd = workspaceCwd(root, args.cwd);
  const timeoutMs = timeoutValue(args.timeout_ms);
  return execute(command, cwd, timeoutMs, environmentValue(args.env));
};
