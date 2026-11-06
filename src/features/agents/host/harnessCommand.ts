import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

interface CommandOptions {
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** A resolved Harness process. `env` carries what the wrapper itself would have set. */
export interface HarnessInvocation {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** `%~dp0` (or `%dp0%`) names the launcher's own directory in a Windows wrapper. */
const WRAPPER_DIRECTORY = /%(?:~dp0|dp0%)/i;

function wrapperPath(scriptPath: string, reference: string): string {
  const relative = reference.replace(WRAPPER_DIRECTORY, "").replace(/^[\\/]+/, "");
  return resolve(dirname(scriptPath), ...relative.split(/[\\/]/));
}

/**
 * A wrapper that starts a bundled runtime with a script argument — the DeepSeek
 * Harness desktop launcher is the shipped example:
 *
 *     "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\...\cli.js" %*
 *
 * The script lives inside `app.asar` and only the bundled Electron can read it,
 * so handing that path to plain node (the generic wrapper branch below) can never
 * work. Return the executable, its own flags and the environment the wrapper sets.
 */
function desktopLauncher(script: string, scriptPath: string, args: readonly string[]): HarnessInvocation | undefined {
  const executable = /"(%(?:~dp0|dp0%)[^"\r\n]*?\.exe)"/i.exec(script)?.[1];
  if (!executable || /^node(?:\.exe)?$/i.test(basename(executable.replace(WRAPPER_DIRECTORY, "")))) return undefined;
  const program = wrapperPath(scriptPath, executable);
  if (!existsSync(program)) return undefined;
  const scriptArgument = /"(%(?:~dp0|dp0%)[^"\r\n]*?\.[cm]?js)"/i.exec(script)?.[1];
  if (!scriptArgument) return undefined;
  const entry = wrapperPath(scriptPath, scriptArgument);
  const between = script.slice(script.indexOf(executable) + executable.length, script.indexOf(scriptArgument));
  const flags = between.replace(/["']/g, " ").split(/\s+/).filter((flag) => flag.startsWith("-"));
  return {
    command: program,
    args: [...flags, entry, ...args],
    ...(/ELECTRON_RUN_AS_NODE\s*=\s*1/i.test(script) ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {})
  };
}

/** Resolve PATH and wrappers, not a version manager's private install layout. */
export function harnessSpawnCommand(command: string, args: readonly string[], options: CommandOptions = {}): HarnessInvocation {
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
  const unwrap = (input: string, selectedNode?: string): HarnessInvocation => {
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
    const launcher = desktopLauncher(script, path, args);
    if (launcher) return launcher;
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
