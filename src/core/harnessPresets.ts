import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { AgentPermission, AgentProfile, HarnessPresetOption } from "../features/agents/contracts.js";
import { harnessSpawnCommand } from "./harnessCommand.js";

const run = promisify(execFile);

export function harnessPresetHelper(): string {
  const packaged = join(__dirname, "..", "media", "harness-presets.mjs");
  return existsSync(packaged) ? packaged : join(__dirname, "..", "..", "media", "harness-presets.mjs");
}

export interface HarnessInstallation {
  /** The executable that runs the preset helper: node, or the desktop binary. */
  command: string;
  /** Flags the launcher itself puts before a script (for example `--expose-internals`). */
  prefixArgs: string[];
  entry: string;
  acpModule: string;
  env?: Record<string, string>;
}

/**
 * `app.asar` is a file to plain node but a directory to the bundled Electron, so
 * the ACP module is located by the install layout instead of by resolving it.
 */
function packagedModule(entry: string, name: string): string {
  const marker = `${sep}node_modules${sep}`;
  const index = entry.lastIndexOf(marker);
  if (index < 0) throw new Error("Cannot locate DeepSeek Harness preset packages. Reinstall @deepseek-ai/dsh.");
  return join(entry.slice(0, index + marker.length), ...name.split("/"), "lib", "index.js");
}

export function harnessInstallation(command: string, cwd = process.cwd()): HarnessInstallation {
  const invocation = harnessSpawnCommand(command, [], { cwd });
  const entry = [...invocation.args].reverse().find((argument) => /\.[cm]?js$/i.test(argument)) ?? invocation.command;
  const prefixArgs = invocation.args.slice(0, invocation.args.indexOf(entry));
  let acpModule: string;
  if (entry.includes(".asar")) acpModule = packagedModule(entry, "@deepseek-ai/dsh-acp");
  else {
    try { acpModule = createRequire(entry).resolve("@deepseek-ai/dsh-acp"); }
    catch { throw new Error("Cannot locate DeepSeek Harness preset packages. Reinstall @deepseek-ai/dsh."); }
  }
  return { command: invocation.command, prefixArgs, entry, acpModule, ...(invocation.env ? { env: invocation.env } : {}) };
}

/**
 * The shipped declaration of one preset, applied as its own launcher layer.
 * Harness declares presets as composition patches inside `dsh-web-app/presets`.
 */
export function harnessPresetLayer(install: HarnessInstallation, id: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return undefined;
  const marker = `${sep}node_modules${sep}`;
  const index = install.entry.lastIndexOf(marker);
  if (index < 0) return undefined;
  return join(install.entry.slice(0, index + marker.length), "@deepseek-ai", "dsh-web-app", "presets", `${id}.patch.yml`);
}

interface NativePreset { id: string; name?: string; description?: string; trust: string; path: string; broken?: string }
const LABELS: Record<string, string> = { standard: "Standard", ptc: "PTC", minimal: "Minimal", cordis: "Create" };

async function presetRows(profile: AgentProfile, cwd = process.cwd()): Promise<NativePreset[]> {
  const install = harnessInstallation(profile.command, cwd);
  const result = await run(install.command, [...install.prefixArgs, harnessPresetHelper(), install.entry, "list"], {
    cwd, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...install.env }
  });
  return JSON.parse(result.stdout) as NativePreset[];
}

/**
 * One successful listing serves every turn. On the desktop install the helper
 * runs inside Electron, so re-listing per session would add seconds to the
 * turn; `Refresh presets` clears this instead.
 */
const presetListings = new Map<string, Promise<HarnessPresetOption[]>>();

export function clearHarnessPresetCache(): void { presetListings.clear(); }

export async function listHarnessPresets(profile: AgentProfile, cwd = process.cwd()): Promise<HarnessPresetOption[]> {
  const key = `${profile.command}\u0000${cwd}`;
  const cached = presetListings.get(key);
  if (cached) return cached;
  const pending = presetRows(profile, cwd).then((rows) => rows.map((row) => {
    // Minimal's native terminal/fs and Create's runtime plugin loader are not confined
    // by the host sandbox. User-authored plugin code has the same process access.
    // Those presets therefore need Full access, and because the sandbox policy cannot
    // confine them they are only applied to a writable turn.
    const unconfined = row.trust !== "system" || !["standard", "ptc"].includes(row.id);
    return {
      id: row.id, label: row.trust === "system" ? LABELS[row.id] ?? row.name ?? row.id : row.name ?? row.id,
      description: row.description ?? "", builtin: row.trust === "system",
      ...(row.broken ? { error: row.broken } : {}),
      requiresFullAccess: unconfined,
      writableTurnsOnly: unconfined
    };
  }));
  presetListings.set(key, pending);
  pending.catch(() => { if (presetListings.get(key) === pending) presetListings.delete(key); });
  return pending;
}

export async function harnessPresetPatch(profile: AgentProfile, id: string, permission: AgentPermission,
  acp: Record<string, unknown> = {}, cwd = process.cwd()): Promise<unknown[]> {
  const option = (await listHarnessPresets(profile, cwd)).find((row) => row.id === id);
  if (!option) throw new Error(`Harness preset '${id}' is unavailable. Refresh presets or choose another preset in a new conversation.`);
  if (option.error) throw new Error(`Harness preset '${id}': ${option.error}`);
  if (option.requiresFullAccess && permission !== "full-access") {
    throw new Error(`Harness preset '${option.label}' requires Full access because it can run plugins or tools outside the Harness sandbox. Choose Standard/PTC for restricted access.`);
  }
  const install = harnessInstallation(profile.command, cwd);
  // The preset declaration itself travels as the launcher layer this row set
  // depends on, so only the registry, its supporting rows and Dext's ACP
  // adapter are inserted here.
  return [
    { id: "acp", disabled: true },
    { insert: [
      { id: "agent-preset-registry", name: "@deepseek-ai/dsh-agent-preset-registry", config: { default: id } },
      { id: "subagent-model-selection-settings", name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings" },
      { id: "cordis-host-runner", name: "@deepseek-ai/dsh-cordis-host-runner" },
      { id: "dext-acp-presets", name: pathToFileURL(harnessPresetHelper()).href, inject: ["acpAppStartup"],
        config: { preset: id, acpModule: install.acpModule, acp } }
    ] }
  ];
}
