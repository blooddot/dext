import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isAbsolute, relative, resolve } from "node:path";
import * as vscode from "vscode";
import type { DeterministicHandler } from "./core/runtime.js";
import type { TerminalResult } from "./core/types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`terminal.run requires a nonempty '${name}'.`);
  }
  return value;
}

function timeoutValue(value: unknown): number {
  const timeout = value === undefined ? DEFAULT_TIMEOUT_MS : value;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`terminal.run timeout_ms must be an integer from 1 to ${MAX_TIMEOUT_MS}.`);
  }
  return timeout;
}

function trustedWorkspaceRoot(): string {
  if (!vscode.workspace.isTrusted) {
    throw new Error("terminal.run requires a trusted workspace.");
  }
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length || folders.some((folder) => folder.uri.scheme !== "file")) {
    throw new Error("terminal.run requires a local file workspace.");
  }
  return folders[0]!.uri.fsPath;
}

function workspaceCwd(root: string, value: unknown): string {
  const requested = value === undefined ? "." : requiredString(value, "cwd");
  const realRoot = realpathSync(root);
  const cwd = realpathSync(resolve(realRoot, requested));
  const pathFromRoot = relative(realRoot, cwd);
  if (isAbsolute(pathFromRoot) || pathFromRoot === ".." || pathFromRoot.startsWith(`..\\`) || pathFromRoot.startsWith("../")) {
    throw new Error("terminal.run cwd must stay inside the current workspace.");
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error("terminal.run cwd must be a directory.");
  }
  return cwd;
}

function appendLimited(current: string, chunk: Buffer): string {
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
  if (remaining <= 0) return current;
  const value = chunk.subarray(0, remaining).toString("utf8");
  return chunk.length > remaining ? `${current}${value}\n[output truncated]` : current + value;
}

function execute(command: string, cwd: string, timeoutMs: number): Promise<TerminalResult> {
  return new Promise((complete, reject) => {
    const started = performance.now();
    const environment = {
      ...process.env,
      TERM: process.env.TERM ?? "xterm-256color",
      FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
      CLICOLOR_FORCE: process.env.CLICOLOR_FORCE ?? "1",
      GIT_PAGER: "cat",
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
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore"
        });
      } else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill();
        }
      } else {
        child.kill();
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendLimited(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    });
  });
}

export const terminalRunHandler: DeterministicHandler = async ({ arguments: args }) => {
  const command = requiredString(args.command, "command");
  const root = trustedWorkspaceRoot();
  const cwd = workspaceCwd(root, args.cwd);
  const timeoutMs = timeoutValue(args.timeout_ms);
  return execute(command, cwd, timeoutMs);
};
