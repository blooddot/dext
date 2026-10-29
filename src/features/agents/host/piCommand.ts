import type { AgentPermission, AgentProfile } from "../contracts/agent.js";
import { resolveCliCommand } from "./agentRunner.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { normalize } from "node:path";

/** Quote Windows batch arguments for cmd.exe, including its second parsing
 * pass through npm-style launchers. Never inspect or rewrite a launcher. */
export function piInvocation(command: string, args: readonly string[]): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args: [...args], windowsVerbatimArguments: false };
  const meta = /([()\][%!^"`<>&|;, *?])/g;
  const double = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(command);
  const quote = (arg: string): string => {
    let value = `"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1')}"`.replace(meta, "^$1");
    if (double) value = value.replace(meta, "^$1");
    return value;
  };
  return { command: process.env.ComSpec || process.env.comspec || "cmd.exe", args: ["/d", "/s", "/c", `"${normalize(command).replace(meta, "^$1")} ${args.map(quote).join(" ")}"`], windowsVerbatimArguments: true };
}

const versions = new Set<string>();
export async function checkPiVersion(command: string, cwd: string, signal?: AbortSignal): Promise<void> {
  const identity = await stat(command);
  const key = `${command}:${identity.size}:${identity.mtimeMs}`;
  signal?.throwIfAborted();
  if (!versions.has(key)) {
    try {
      const invocation = piInvocation(command, ["--version", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline"]);
      const result = await promisify(execFile)(invocation.command, invocation.args, {
        cwd, windowsHide: true, timeout: 10000, maxBuffer: 65536, ...(signal ? { signal } : {}), windowsVerbatimArguments: invocation.windowsVerbatimArguments
      });
      const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/.exec(result.stdout.trim());
      if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 4)) throw new Error("The associated Pi CLI must support the Pi 1.4 RPC interface. Configure a compatible Pi command.");
      versions.add(key);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.message.startsWith("The associated Pi CLI must")) throw error;
      throw new Error("The associated Pi command could not start or report its version. Check the command and CLI environment, then reconnect.");
    }
  }
}

export function piCommand(profile: Pick<AgentProfile, "command" | "provider">): string {
  const command = resolveCliCommand(profile.command, profile.provider);
  if (!command) throw new Error(`Pi CLI '${profile.command}' was not found on PATH. Associate an installed Pi using Dext: Configure Agent.`);
  return command;
}
export function piExtraArguments(args: readonly string[]): string[] {
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--append-system-prompt" || !args[index + 1]?.trim()) throw new Error("Pi extra arguments support only --append-system-prompt value pairs. Dext owns RPC, session, tools, and permissions.");
  }
  return [...args];
}
export function piPermission(allowWrite: boolean, permission?: AgentPermission, trusted = false): AgentPermission {
  if (!allowWrite) return "read-only";
  if (!trusted) throw new Error("Pi writes require a trusted local workspace.");
  if (permission !== "full-access") throw new Error("Pi does not support Workspace write. Explicitly select Full access to edit files or run commands.");
  return "full-access";
}
export function piTools(permission: AgentPermission, result: boolean, platform: NodeJS.Platform = process.platform, trusted = false, projectQuery = false): string[] {
  return ["read", "grep", "find", "ls", "dext_request_user_input",
    ...(result ? ["dext_submit_result"] : []),
    ...(trusted && projectQuery ? ["dext_project_query"] : []),
    ...(permission === "read-only" && trusted ? ["dext_fetch"] : []),
    ...(permission === "full-access" ? ["write", "edit", platform === "win32" ? "powershell" : "bash", "mcp__*"] : [])];
}
export function piArguments(options: {
  extensionPath: string; sessionDirectory: string; sessionPath?: string; trusted: boolean;
  permission: AgentPermission; result?: boolean; ephemeral?: boolean; extra?: readonly string[];
  projectQuery?: boolean;
}): string[] {
  return [...piExtraArguments(options.extra ?? []), "--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve", "--offline",
    ...(!options.trusted ? ["--no-context-files"] : []),
    "--extension", options.extensionPath,
    ...(options.permission === "full-access" ? ["--extension", "builtin:mcp"] : ["--no-mcp"]),
    "--tools", piTools(options.permission, Boolean(options.result), process.platform, options.trusted, options.projectQuery).join(","),
    ...(options.result || options.ephemeral ? ["--no-session"] : ["--session-dir", options.sessionDirectory, ...(options.sessionPath ? ["--session", options.sessionPath] : [])])];
}
