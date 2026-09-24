import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

interface CommandOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Resolve PATH and wrappers, not a version manager's private install layout. */
export function harnessSpawnCommand(command: string, args: readonly string[], options: CommandOptions = {}): { command: string; args: string[] } {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windows = platform === "win32";
  const locate = (name: string): string | undefined => {
    const names = windows && !extname(name)
      ? [...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => name + ext.toLowerCase()), name]
      : [name];
    const directories = isAbsolute(name) || /[/\\]/.test(name) ? [cwd] : (env.Path ?? env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const directory of directories) {
      for (const candidate of names) {
        const path = resolve(directory, candidate);
        if (existsSync(path)) return path;
      }
    }
    return undefined;
  };
  const which = (manager: string, name: string): string => {
    const executable = locate(manager);
    if (!executable || /\.(?:cmd|bat)$/i.test(executable)) {
      throw new Error(`Cannot resolve the Harness shim: ${manager} must be available on PATH.`);
    }
    try {
      const path = execFileSync(executable, ["which", name], {
        cwd, env, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      if (isAbsolute(path)) {
        const found = locate(path);
        if (found) return found;
      }
    } catch { /* Report an actionable error without leaking manager diagnostics. */ }
    throw new Error(`DeepSeek Harness CLI '${name}' could not be resolved using ${manager}. Reinstall @deepseek-ai/dsh.`);
  };
  const visited = new Set<string>();
  const unwrap = (input: string, selectedNode?: string): { command: string; args: string[] } => {
    const path = locate(input);
    if (!path) throw new Error(`DeepSeek Harness CLI '${input}' was not found on PATH. Install @deepseek-ai/dsh.`);
    if (visited.has(path) || visited.size >= 8) throw new Error("Cannot resolve a recursive Harness command shim.");
    visited.add(path);
    const canonical = realpathSync(path);
    const node = selectedNode ?? (existsSync(join(dirname(path), windows ? "node.exe" : "node"))
      ? join(dirname(path), windows ? "node.exe" : "node") : "node");
    if (/\.[cm]?js$/i.test(canonical)) return { command: node, args: [canonical, ...args] };

    // Only inspect the wrapper header. Native executables can be very large.
    const header = Buffer.alloc(1024 * 1024);
    const fd = openSync(canonical, "r");
    let script: string;
    try { script = header.subarray(0, readSync(fd, header, 0, header.length, 0)).toString("utf8"); }
    finally { closeSync(fd); }
    const target = basename(canonical).replace(/\.exe$/i, "");
    const manager = target === "mise" || script.includes("__MISE_SHIM_PATH") || /[/\\]mise[/\\]shims[/\\]/i.test(path) || /\bmise(?:\.exe)?["']?\s+(?:x|exec)\b/.test(script) ? "mise"
      : /\basdf\b[^\r\n]*\bexec\b/.test(script) ? "asdf" : undefined;
    if (manager) {
      const name = basename(path).replace(/\.(?:exe|cmd|bat)$/i, "");
      return unwrap(which(manager, name), which(manager, "node"));
    }
    const relative = /["']%(?:~dp0|dp0%)[\\/]*([^"'\r\n]*?\.[cm]?js)/i.exec(script)?.[1]
      ?? /["']\$(?:basedir|\{basedir\})\/([^"'\r\n]*?\.[cm]?js)/.exec(script)?.[1];
    if (relative) {
      const entry = resolve(dirname(path), ...relative.split(/[\\/]/));
      if (existsSync(entry)) return { command: node, args: [realpathSync(entry), ...args] };
      throw new Error("DeepSeek Harness CLI shim is incomplete. Reinstall @deepseek-ai/dsh.");
    }
    if (/\.(?:cmd|bat)$/i.test(path)) throw new Error("DeepSeek Harness CLI shim is incomplete. Reinstall @deepseek-ai/dsh.");
    return { command: path, args: [...args] };
  };
  return unwrap(command.trim());
}
