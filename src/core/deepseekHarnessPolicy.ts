import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPermission } from "../agentProfiles.js";

export const HARNESS_VERSION = "0.1.2-rc.1";
export const harnessMode = (permission: AgentPermission): string => permission === "full-access" ? "danger-full-access" : permission;

/** All preset names resolve to the same boundary, including a saved user default.
 * Fresh sessions are used when this boundary changes; resume never changes policy. */
export function harnessPolicyPatch(permission: AgentPermission, cwd: string): string {
  const mode = harnessMode(permission);
  const preset = { sandbox: mode, approval: permission === "full-access" ? "ask" : "never" };
  return JSON.stringify([
    { id: "sandbox-policy", config: { mode, workspaceRoot: cwd } },
    { id: "approval", config: { policy: preset.approval } },
    { id: "permission", config: { defaultPreset: mode, presets: {
      "read-only": preset, "workspace-write": preset, "danger-full-access": preset
    } } }
  ], null, 2);
}

export async function createHarnessPolicy(permission: AgentPermission, cwd: string): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "dext-harness-policy-"));
  const path = join(directory, "policy.json");
  try { await writeFile(path, harnessPolicyPatch(permission, cwd), "utf8"); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
}

export async function harnessBinding(cwd: string, permission: AgentPermission, command: string, args: readonly string[]): Promise<string> {
  const canonical = await realpath(cwd);
  return createHash("sha256").update(JSON.stringify([canonical, permission, command, args, process.env.DSH_HOME ?? ""])).digest("hex");
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
