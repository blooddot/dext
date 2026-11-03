import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** One Pi package the user installed with `pi install`. */
export interface PiPlugin {
  /** The settings entry, so a conversation's selection round-trips as text. */
  id: string;
  label: string;
  /** Directory Pi loads with `--extension`. */
  path: string;
}

export function piAgentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}

/** Resolves declared packages to loadable directories. Pi only honors `-e` for
 * a local path in this offline RPC run, so `npm:` names map onto Pi's managed
 * install and anything fetched (git, URL) is skipped.
 * shortcut: git and URL packages stay unavailable, resolve them when Pi hands out a local path. */
export function piPlugins(settings: string, agentDirectory: string): PiPlugin[] {
  let declared: unknown;
  try { declared = (JSON.parse(settings) as { packages?: unknown }).packages; } catch { return []; }
  if (!Array.isArray(declared)) return [];
  const plugins = new Map<string, PiPlugin>();
  for (const entry of declared) {
    const source = typeof entry === "string" ? entry
      : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source
      : "";
    const id = source.trim();
    if (!id || /^(?:git:|https?:)/i.test(id)) continue;
    const path = id.startsWith("npm:") ? join(agentDirectory, "npm", "node_modules", id.slice(4))
      : isAbsolute(id) ? id : resolve(agentDirectory, id);
    if (!existsSync(path)) continue;
    plugins.set(id, { id, label: id.startsWith("npm:") ? id.slice(4) : id, path });
  }
  return [...plugins.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function installedPiPlugins(agentDirectory = piAgentDirectory()): PiPlugin[] {
  try { return piPlugins(readFileSync(join(agentDirectory, "settings.json"), "utf8"), agentDirectory); } catch { return []; }
}
