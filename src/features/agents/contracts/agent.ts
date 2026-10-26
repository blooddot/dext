


import type {
  AgentPermission,
  WritableAgentPermission
} from "../../../shared/contracts/permissions.js";

export type { AgentPermission, WritableAgentPermission };

export type AgentProvider = "codex" | "claude" | "deepseek-harness" | "pi";


/** Profile IDs accepted by the `dext.agentCli` setting. Keep this separate
 * from the settings manifest so the runtime can validate hand-entered IDs. */
export const SUPPORTED_AGENT_PROFILE_IDS: readonly AgentProvider[] = ["codex", "claude", "deepseek-harness", "pi"];


export interface AgentProfile {
  id: string;
  label: string;
  provider: AgentProvider;
  command: string;
  /** Absent means both existing writable tiers. Read-only requests are separate. */
  writablePermissions?: WritableAgentPermission[];
  models: string[];
  modelOptions?: AgentModelOption[];
  presets?: HarnessPresetOption[];
  defaults?: Pick<AgentSelection, "model" | "reasoningEffort" | "speed">;
}


/**
 * One host-owned MCP server injected into a conversation. Dext launches the tool process; the
 * provider only receives the connection details, so no user manifest or system Node install is
 * involved. Only stdio is used today because the supported providers accept it.
 */
export interface AgentMcpServer {
  name: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}


export interface AgentModelOption {
  id: string;
  label: string;
  /** ACP model-provider label, used to keep Harness choices readable. */
  group?: string;
  defaultReasoningEffort?: string;
  isDefault?: boolean;
  reasoningEfforts: string[];
  speedTiers: string[];
  serviceTiers: string[];
}


export const AGENT_PERMISSIONS: readonly WritableAgentPermission[] = ["workspace-write", "full-access"];


export interface HarnessPresetOption {
  id: string;
  label: string;
  description: string;
  builtin: boolean;
  requiresFullAccess: boolean;
  /** The preset's tools run outside the Harness sandbox, so the host only hands
   * it to a writable turn: a read-only turn falls back to a confined preset.
   * Absent on profiles persisted before this flag existed; treat it as
   * `requiresFullAccess`. */
  writableTurnsOnly?: boolean;
  error?: string;
}


export interface AgentSelection {
  agentPreset?: string;
  mode?: "agent" | "ask" | "plan" | "code";
  /** Agent and Plan select a write scope; Ask always runs read-only. */
  permission?: WritableAgentPermission;
  profileId?: string;
  model?: string;
  reasoningEffort?: string;
  speed?: string;
  serviceTier?: string;
  /** Skills enabled for this conversation. Empty or absent means none. A new
   * tab never inherits another tab's selection. */
  skills?: string[];
}


export type StoredAgentProfile = AgentProfile;
