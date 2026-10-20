


export type AgentProvider = "codex" | "claude" | "deepseek-harness";


/** Profile IDs accepted by the `dext.agentCli` setting. Keep this separate
 * from the settings manifest so the runtime can validate hand-entered IDs. */
export const SUPPORTED_AGENT_PROFILE_IDS: readonly AgentProvider[] = ["codex", "claude", "deepseek-harness"];


export interface AgentProfile {
  id: string;
  label: string;
  provider: AgentProvider;
  command: string;
  models: string[];
  modelOptions?: AgentModelOption[];
  presets?: HarnessPresetOption[];
  defaults?: Pick<AgentSelection, "model" | "reasoningEffort" | "speed">;
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


/** Provider-level access used internally for conversations and typed calls. */
export type AgentPermission = "read-only" | "workspace-write" | "full-access";


/** Agent and Plan expose write scopes only. Ask is the dedicated read-only
 * mode; the internal `read-only` permission remains available to it and to
 * preview-only typed Agent calls. */
export type WritableAgentPermission = Exclude<AgentPermission, "read-only">;


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
}


export type StoredAgentProfile = AgentProfile;