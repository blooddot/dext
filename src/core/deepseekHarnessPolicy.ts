import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import type { AgentPermission } from "../features/agents/contracts.js";

export const harnessMode = (permission: AgentPermission): string => permission === "full-access" ? "danger-full-access" : permission;
export interface HarnessDefaultModel { provider: string; model: string }
export interface HarnessLaunchSettings {
  defaultModel?: HarnessDefaultModel;
  /** Provider definitions are non-secret configuration; credential references remain opaque. */
  piAiProviders?: Record<string, unknown>;
  /** The `llm-deepseek` endpoint and model catalog; both are non-secret configuration. */
  deepseekProvider?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function launchSettings(entries: Map<string, Record<string, unknown>>): HarnessLaunchSettings {
  const defaultModel = record(entries.get("agent-default-model"));
  const provider = defaultModel?.provider, model = defaultModel?.model;
  const providers = record(entries.get("llm-pi-ai")?.providers);
  const deepseekProvider = entries.get("llm-deepseek");
  return {
    ...(typeof provider === "string" && provider && typeof model === "string" && model
      ? { defaultModel: { provider, model } } : {}),
    ...(providers && Object.keys(providers).length ? { piAiProviders: providers } : {}),
    ...(deepseekProvider && Object.keys(deepseekProvider).length ? { deepseekProvider } : {})
  };
}

/**
 * The ACP profile does not mount settings-defined routes by itself. Mirror the
 * non-secret sections Dext owns into its disposable overlay; the user profile
 * remains untouched. `llm-deepseek` is read alongside pi-ai because the desktop
 * app stores its endpoint and model catalog in that entry.
 */
export function harnessLaunchSettingsFromYaml(source: string): HarnessLaunchSettings | undefined {
  try {
    const settings = record(parse(source));
    if (!settings) return undefined;
    return launchSettings(new Map(Object.entries(settings).flatMap(([id, value]) => {
      const config = record(value);
      return config ? [[id, config] as const] : [];
    })));
  } catch { return undefined; }
}

/**
 * The desktop app owns `$DSH_HOME/profiles/desktop/cordis.patch.yml`, whose
 * top-level YAML is a patch list rather than the section map `settings.yaml`
 * uses. Read only the entries Dext mirrors, so a model added in the Harness app
 * reaches the ACP profile without copying or modifying any user file.
 */
export function harnessLaunchSettingsFromProfilePatch(source: string): HarnessLaunchSettings | undefined {
  try {
    const parsed: unknown = parse(source);
    if (!Array.isArray(parsed)) return undefined;
    const entries = new Map<string, Record<string, unknown>>();
    for (const item of parsed) {
      const entry = record(item);
      const id = entry?.id, config = record(entry?.config);
      // A later row for the same id is the one the loader keeps.
      if (typeof id === "string" && config) entries.set(id, config);
    }
    return launchSettings(entries);
  } catch { return undefined; }
}

/**
 * Resolve the Harness home the same way the launcher does: `$DSH_HOME` (blank
 * counts as unset), then `~/.dsh`. The result is platform-neutral, so macOS and
 * Windows share one path expression with no hardcoded drive or separator.
 */
function harnessHome(): string {
  return resolve(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

/**
 * Read the launch settings Dext mirrors into its ACP overlay. Values come from
 * `$DSH_HOME/settings.yaml` first; a field that file does not define falls back
 * to the desktop profile's patch, which is where the Harness app writes the
 * model list and default route on current releases. Both paths are derived from
 * the resolved Harness home, never from a platform-specific literal.
 */
export async function readHarnessLaunchSettings(
  settingsPath = join(harnessHome(), "settings.yaml"),
  desktopPatchPath = join(harnessHome(), "profiles", "desktop", "cordis.patch.yml")
): Promise<HarnessLaunchSettings | undefined> {
  const [settingsSource, profileSource] = await Promise.all([readOptional(settingsPath), readOptional(desktopPatchPath)]);
  const settings = settingsSource === undefined ? undefined : harnessLaunchSettingsFromYaml(settingsSource);
  const profile = profileSource === undefined ? undefined : harnessLaunchSettingsFromProfilePatch(profileSource);
  const defaultModel = settings?.defaultModel ?? profile?.defaultModel;
  const piAiProviders = settings?.piAiProviders ?? profile?.piAiProviders;
  const deepseekProvider = settings?.deepseekProvider ?? profile?.deepseekProvider;
  if (!defaultModel && !piAiProviders && !deepseekProvider) return undefined;
  return {
    ...(defaultModel ? { defaultModel } : {}),
    ...(piAiProviders ? { piAiProviders } : {}),
    ...(deepseekProvider ? { deepseekProvider } : {})
  };
}

/** All preset names resolve to the same boundary, including a saved user default.
 * Fresh sessions are used when this boundary changes; resume never changes policy. */
export function harnessPolicyPatch(permission: AgentPermission, cwd: string, settings?: HarnessLaunchSettings): string {
  const mode = harnessMode(permission);
  const preset = { sandbox: mode, approval: permission === "full-access" ? "ask" : "never" };
  return JSON.stringify([
    ...(settings?.piAiProviders ? [{ id: "llm-pi-ai", config: { providers: settings.piAiProviders } }] : []),
    ...(settings?.deepseekProvider ? [{ id: "llm-deepseek", config: settings.deepseekProvider }] : []),
    ...(settings?.defaultModel ? [{ id: "acp", config: settings.defaultModel }] : []),
    { id: "sandbox-policy", config: { mode, workspaceRoot: cwd } },
    { id: "approval", config: { policy: preset.approval } },
    { id: "permission", config: { defaultPreset: mode, presets: {
      "read-only": preset, "workspace-write": preset, "danger-full-access": preset
    } } }
  ], null, 2);
}

export async function createHarnessPolicy(permission: AgentPermission, cwd: string, settings?: HarnessLaunchSettings, presetPatch: readonly unknown[] = []): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "dext-harness-policy-"));
  const path = join(directory, "policy.json");
  try {
    const policy = JSON.parse(harnessPolicyPatch(permission, cwd, settings)) as { id: string }[];
    const rows = [...presetPatch, ...policy];
    await writeFile(path, JSON.stringify(rows, null, 2), "utf8");
  }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
}

export async function harnessBinding(cwd: string, permission: AgentPermission, command: string, args: readonly string[], settings?: HarnessLaunchSettings, agentPreset?: string): Promise<string> {
  const canonical = await realpath(cwd);
  return createHash("sha256").update(JSON.stringify([canonical, permission, command, args, process.env.DSH_HOME ?? "", settings ?? null, ...(agentPreset ? [agentPreset] : [])])).digest("hex");
}

/** The provider slot stores a versioned binding alongside the native session id. */
export function encodeHarnessSession(id: string, binding: string): string {
  return `dsh1:${Buffer.from(JSON.stringify({ id, binding })).toString("base64url")}`;
}

export function decodeHarnessSession(value: string): { id: string; binding: string } {
  try {
    if (!value.startsWith("dsh1:")) throw new Error();
    const parsed = JSON.parse(Buffer.from(value.slice(5), "base64url").toString()) as { id?: unknown; binding?: unknown };
    if (typeof parsed.id !== "string" || !parsed.id || typeof parsed.binding !== "string") throw new Error();
    return { id: parsed.id, binding: parsed.binding };
  } catch { throw new Error("Invalid DeepSeek Harness session binding. Start a new conversation."); }
}
