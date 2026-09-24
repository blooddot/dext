import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { AgentPermission, AgentProfile, HarnessPresetOption } from "../agentProfiles.js";
import { harnessSpawnCommand } from "./harnessCommand.js";

const run = promisify(execFile);
export const HARNESS_PRESET_AGENT_ROWS = [
  "tool-bash", "tool-pwsh", "tool-jobs", "tool-fs", "tool-fs-search", "tool-str-replace-editor",
  "skill-filesystem", "tool-skill", "command-goal", "tool-goal", "plan-mode", "compaction-basic",
  "command-compact", "tool-result-pruner", "tool-subagent-control", "tool-subagent-list-agents",
  "tool-subagent", "tool-subagent-fork", "workflow-worker-thread", "tool-workflow", "tool-ralph",
  "agent-instructions", "tool-todo", "tool-web"
];

export function harnessPresetHelper(): string {
  const packaged = join(__dirname, "..", "media", "harness-presets.mjs");
  return existsSync(packaged) ? packaged : join(__dirname, "..", "..", "media", "harness-presets.mjs");
}

export function harnessInstallation(command: string, cwd = process.cwd()): { node: string; entry: string; acpModule: string } {
  const invocation = harnessSpawnCommand(command, [], { cwd });
  const entry = invocation.args[0] && /\.[cm]?js$/i.test(invocation.args[0]) ? invocation.args[0] : invocation.command;
  try {
    const acpModule = createRequire(entry).resolve("@deepseek-ai/dsh-acp");
    return { node: invocation.args.length ? invocation.command : "node", entry, acpModule };
  } catch { throw new Error("Cannot locate DeepSeek Harness preset packages. Reinstall @deepseek-ai/dsh."); }
}

interface NativePreset { id: string; name?: string; description?: string; trust: string; path: string; broken?: string }
const LABELS: Record<string, string> = { standard: "Standard", ptc: "PTC", minimal: "Minimal", cordis: "Create" };

async function presetCommand(profile: AgentProfile, action: string, args: string[] = [], cwd = process.cwd()): Promise<unknown> {
  const install = harnessInstallation(profile.command, cwd);
  const result = await run(install.node, [harnessPresetHelper(), install.entry, action, ...args], {
    cwd, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024
  });
  return JSON.parse(result.stdout) as unknown;
}

export async function listHarnessPresets(profile: AgentProfile, cwd = process.cwd()): Promise<HarnessPresetOption[]> {
  const rows = await presetCommand(profile, "list", [], cwd) as NativePreset[];
  return rows.map((row) => {
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
  });
}

export async function copyHarnessPreset(profile: AgentProfile, source: string, id: string, cwd = process.cwd()): Promise<string> {
  const result = await presetCommand(profile, "copy", [source, id], cwd) as { path: string };
  return join(result.path, "agent.cordis.yml");
}

export async function harnessPresetFile(profile: AgentProfile, id: string, cwd = process.cwd()): Promise<string> {
  const rows = await presetCommand(profile, "list", [], cwd) as NativePreset[];
  const row = rows.find((candidate) => candidate.id === id);
  if (!row || row.trust === "system") throw new Error("Copy a built-in preset before editing it.");
  return row.path;
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
  return [
    ...HARNESS_PRESET_AGENT_ROWS.map((row) => ({ id: row, disabled: true })),
    { id: "acp", disabled: true },
    { insert: [
      { id: "agent-presets", name: "@deepseek-ai/dsh-agent-presets", config: { default: "standard" } },
      { id: "code-runtime", name: "@deepseek-ai/dsh-code-runtime-worker-thread" },
      { id: "subagent-model-selection-settings", name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings" },
      { id: "cordis-host-runner", name: "@deepseek-ai/dsh-cordis-host-runner" },
      { id: "dext-acp-presets", name: pathToFileURL(harnessPresetHelper()).href, inject: ["acpAppStartup"],
        config: { preset: id, acpModule: install.acpModule, acp } }
    ] }
  ];
}
