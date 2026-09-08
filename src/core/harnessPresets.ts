import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { AgentPermission, AgentProfile, HarnessPresetOption } from "../agentProfiles.js";
import { resolveCliCommand } from "./agentRunner.js";
import { harnessSpawnCommand } from "./deepseekHarnessTransport.js";

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

export function harnessInstallation(command: string): { node: string; entry: string; acpModule: string } {
  const resolved = resolveCliCommand(command, "deepseek-harness");
  if (!resolved) throw new Error("DeepSeek Harness was not found. Configure its dsh executable first.");
  const invocation = harnessSpawnCommand(realpathSync(resolved), []);
  const entry = invocation.args[0] && /\.[cm]?js$/i.test(invocation.args[0]) ? invocation.args[0] : realpathSync(resolved);
  try {
    const acpModule = createRequire(entry).resolve("@deepseek-ai/dsh-acp");
    return { node: invocation.args.length ? invocation.command : "node", entry, acpModule };
  } catch { throw new Error("Cannot locate Harness preset packages. Configure the installed dsh Node entry or npm executable."); }
}

interface NativePreset { id: string; name?: string; description?: string; trust: string; path: string; broken?: string }
const LABELS: Record<string, string> = { standard: "Standard", ptc: "PTC", minimal: "Minimal", cordis: "Create" };

async function presetCommand(profile: AgentProfile, action: string, args: string[] = []): Promise<unknown> {
  const install = harnessInstallation(profile.command);
  const result = await run(install.node, [harnessPresetHelper(), install.entry, action, ...args], {
    windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024
  });
  return JSON.parse(result.stdout) as unknown;
}

export async function listHarnessPresets(profile: AgentProfile): Promise<HarnessPresetOption[]> {
  const rows = await presetCommand(profile, "list") as NativePreset[];
  return rows.map((row) => ({
    id: row.id, label: row.trust === "system" ? LABELS[row.id] ?? row.name ?? row.id : row.name ?? row.id,
    description: row.description ?? "", builtin: row.trust === "system",
    ...(row.broken ? { error: row.broken } : {}),
    // Minimal's native terminal/fs and Create's runtime plugin loader are not confined
    // by the host sandbox. User-authored plugin code has the same process access.
    requiresFullAccess: row.trust !== "system" || !["standard", "ptc"].includes(row.id)
  }));
}

export async function copyHarnessPreset(profile: AgentProfile, source: string, id: string): Promise<string> {
  const result = await presetCommand(profile, "copy", [source, id]) as { path: string };
  return join(result.path, "agent.cordis.yml");
}

export async function harnessPresetFile(profile: AgentProfile, id: string): Promise<string> {
  const rows = await presetCommand(profile, "list") as NativePreset[];
  const row = rows.find((candidate) => candidate.id === id);
  if (!row || row.trust === "system") throw new Error("Copy a built-in preset before editing it.");
  return row.path;
}

export async function harnessPresetPatch(profile: AgentProfile, id: string, permission: AgentPermission,
  acp: Record<string, unknown> = {}): Promise<unknown[]> {
  const option = (await listHarnessPresets(profile)).find((row) => row.id === id);
  if (!option) throw new Error(`Harness preset '${id}' is unavailable. Refresh presets or choose another preset in a new conversation.`);
  if (option.error) throw new Error(`Harness preset '${id}': ${option.error}`);
  if (option.requiresFullAccess && permission !== "full-access") {
    throw new Error(`Harness preset '${option.label}' requires Full access because it can run plugins or tools outside the Harness sandbox. Choose Standard/PTC for restricted access.`);
  }
  const install = harnessInstallation(profile.command);
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
