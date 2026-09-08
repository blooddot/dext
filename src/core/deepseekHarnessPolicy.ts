import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { AgentPermission } from "../agentProfiles.js";

export const HARNESS_VERSION = "0.1.2-rc.1";
export const harnessMode = (permission: AgentPermission): string => permission === "full-access" ? "danger-full-access" : permission;
export interface HarnessDefaultModel { provider: string; model: string }
export interface HarnessLaunchSettings {
  defaultModel?: HarnessDefaultModel;
  /** Provider definitions are non-secret configuration; credential references remain opaque. */
  piAiProviders?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * The ACP profile does not mount settings-defined pi-ai routes by itself in
 * Harness 0.1.2-rc.1. Mirror the non-secret provider section and its default
 * route in Dext's disposable overlay; the user profile remains untouched.
 */
export function harnessLaunchSettingsFromYaml(source: string): HarnessLaunchSettings | undefined {
  try {
    const settings = record(parse(source));
    if (!settings) return undefined;
    const defaultModel = record(settings["agent-default-model"]);
    const provider = defaultModel?.provider, model = defaultModel?.model;
    const piAi = record(settings["llm-pi-ai"]);
    const providers = record(piAi?.providers);
    return {
      ...(typeof provider === "string" && provider && typeof model === "string" && model
        ? { defaultModel: { provider, model } } : {}),
      ...(providers && Object.keys(providers).length ? { piAiProviders: providers } : {})
    };
  } catch { return undefined; }
}

export async function readHarnessLaunchSettings(settingsPath = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "settings.yaml")): Promise<HarnessLaunchSettings | undefined> {
  try { return harnessLaunchSettingsFromYaml(await readFile(settingsPath, "utf8")); }
  catch { return undefined; }
}

/** All preset names resolve to the same boundary, including a saved user default.
 * Fresh sessions are used when this boundary changes; resume never changes policy. */
export function harnessPolicyPatch(permission: AgentPermission, cwd: string, settings?: HarnessLaunchSettings): string {
  const mode = harnessMode(permission);
  const preset = { sandbox: mode, approval: permission === "full-access" ? "ask" : "never" };
  return JSON.stringify([
    ...(settings?.piAiProviders ? [{ id: "llm-pi-ai", config: { providers: settings.piAiProviders } }] : []),
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
