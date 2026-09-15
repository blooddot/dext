import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, readdirSync } from "node:fs";
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
    throw new Error(`Cannot resolve '${name}' using ${manager}. Check its selected version in the workspace or configure the dsh Node entry.`);
  };
  const visited = new Set<string>();
  const unwrap = (input: string, selectedNode?: string): { command: string; args: string[] } => {
    const path = locate(input);
    if (!path) throw new Error(`DeepSeek Harness command '${input}' was not found. Install @deepseek-ai/dsh or configure its executable path.`);
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
      : target === "volta" || /\bvolta(?:\.exe)?["']?\s+run\b/i.test(script) || script.includes("VOLTA_HOME") ? "volta"
      : /\basdf\b[^\r\n]*\bexec\b/.test(script) ? "asdf" : undefined;
    if (manager) {
      const name = basename(path).replace(/\.(?:exe|cmd|bat)$/i, "");
      let miseNode: string | undefined;
      if (manager === "mise") {
        miseNode = (() => {
          try {
            const nodeRoot = join(dirname(path), "..", "installs", "node");
            const versions = readdirSync(nodeRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).sort().reverse();
            const candidate = versions.map((version) => join(nodeRoot, version, "node.exe")).find((item) => existsSync(item));
            return candidate;
          } catch { return undefined; }
        })();
        const roots = [join(dirname(path), "..", "installs", "npm-deepseek-ai-dsh"), join(dirname(dirname(path)), "installs", "npm-deepseek-ai-dsh")];
        try {
          for (const root of roots) for (const version of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)) {
            const manifest = JSON.parse(readFileSync(join(root, version, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> };
            if (manifest.dependencies?.["@deepseek-ai/dsh"] !== "0.1.5-rc.1") continue;
            const shim = join(root, version, "node_modules", ".bin", windows ? "dsh.cmd" : "dsh");
            if (existsSync(shim)) return unwrap(shim, miseNode);
          }
        } catch { /* Fall through to the manager's public resolver. */ }
      }
      try { return unwrap(which(manager, name), which(manager, "node")); } catch (error) {
        // Test doubles and older manager shims may not expose `which`; inspect
        // only the manager-owned sibling installation as a final fallback.
        if (manager === "mise") {
          const roots = [join(dirname(path), "..", "installs", "npm-deepseek-ai-dsh"), join(dirname(dirname(path)), "installs", "npm-deepseek-ai-dsh")];
          for (const root of roots) for (const version of readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name)) {
            try {
              const manifest = JSON.parse(readFileSync(join(root, version, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> };
              if (manifest.dependencies?.["@deepseek-ai/dsh"] !== "0.1.5-rc.1") continue;
              const shim = join(root, version, "node_modules", ".bin", windows ? "dsh.cmd" : "dsh");
              if (existsSync(shim)) return unwrap(shim, miseNode);
            } catch { /* Keep searching installed versions. */ }
          }
        }
        if (manager === "volta") {
          const shim = join(dirname(dirname(path)), "tools", "image", "packages", "@deepseek-ai", "dsh", windows ? "dsh.cmd" : "dsh");
          if (existsSync(shim)) return unwrap(shim);
        }
        throw error;
      }
    }
    const relative = /["']%(?:~dp0|dp0%)[\\/]*([^"'\r\n]*?\.[cm]?js)/i.exec(script)?.[1]
      ?? /["']\$(?:basedir|\{basedir\})\/([^"'\r\n]*?\.[cm]?js)/.exec(script)?.[1];
    if (relative) {
      const entry = resolve(dirname(path), ...relative.split(/[\\/]/));
      if (existsSync(entry)) return { command: node, args: [realpathSync(entry), ...args] };
      throw new Error("Cannot resolve this Harness command shim: its Node entry is missing. Reinstall dsh or configure its Node entry.");
    }
    if (/\.(?:cmd|bat)$/i.test(path)) throw new Error("Cannot resolve this Harness command shim. Configure the dsh Node entry or executable path.");
    return { command: path, args: [...args] };
  };
  return unwrap(command.trim());
}
