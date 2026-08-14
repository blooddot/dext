import type * as vscode from "vscode";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AgentProvider = "codex" | "claude" | "aioa";

export interface AgentProfile {
  id: string;
  label: string;
  provider: AgentProvider;
  command: string;
  models: string[];
  modelOptions?: AgentModelOption[];
}

export interface AgentModelOption {
  id: string;
  label: string;
  defaultReasoningEffort?: string;
  reasoningEfforts: string[];
  speedTiers: string[];
  serviceTiers: string[];
}

export interface AgentSelection {
  profileId?: string;
  model?: string;
  reasoningEffort?: string;
  speed?: string;
  serviceTier?: string;
}

const STORAGE_KEY = "dext.agentProfiles";
const SELECTION_KEY = "dext.agentSelection";

function configuredCodexModel(): string | undefined {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) return undefined;
  try {
    const content = readFileSync(configPath, "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']\s*$/m.exec(content)?.[1];
  } catch {
    return undefined;
  }
}

function codexModelOptions(): AgentModelOption[] {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const cachePath = join(codexHome, "models_cache.json");
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as { models?: unknown };
    if (Array.isArray(parsed.models)) {
      const options = parsed.models.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const value = candidate as {
          slug?: unknown;
          display_name?: unknown;
          default_reasoning_level?: unknown;
          supported_reasoning_levels?: unknown;
          additional_speed_tiers?: unknown;
          service_tiers?: unknown;
        };
        if (typeof value.slug !== "string") return [];
        const reasoningEfforts = Array.isArray(value.supported_reasoning_levels)
          ? value.supported_reasoning_levels.flatMap((item) =>
            item && typeof item === "object" && typeof (item as { effort?: unknown }).effort === "string"
              ? [(item as { effort: string }).effort]
              : [])
          : [];
        const speedTiers = ["standard", ...(Array.isArray(value.additional_speed_tiers)
          ? value.additional_speed_tiers.filter((item): item is string => typeof item === "string")
          : [])];
        const serviceTiers = ["default", ...(Array.isArray(value.service_tiers)
          ? value.service_tiers.flatMap((item) =>
            item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
              ? [(item as { id: string }).id]
              : [])
          : [])];
        return [{
          id: value.slug,
          label: typeof value.display_name === "string" ? value.display_name : value.slug,
          ...(typeof value.default_reasoning_level === "string" ? { defaultReasoningEffort: value.default_reasoning_level } : {}),
          reasoningEfforts: [...new Set(reasoningEfforts)],
          speedTiers: [...new Set(speedTiers)],
          serviceTiers: [...new Set(serviceTiers)]
        }];
      });
      if (options.length) return options;
    }
  } catch {
    // The cache is optional; the CLI default remains usable without it.
  }
  const configured = configuredCodexModel();
  return configured ? [{ id: configured, label: configured, reasoningEfforts: [], speedTiers: [], serviceTiers: [] }] : [];
}

const CODEX_MODELS = codexModelOptions();
const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: AgentModelOption[] = [
  { id: "opus", label: "Opus", reasoningEfforts: CLAUDE_REASONING_EFFORTS, speedTiers: [], serviceTiers: [] },
  { id: "sonnet", label: "Sonnet", reasoningEfforts: CLAUDE_REASONING_EFFORTS, speedTiers: [], serviceTiers: [] }
];
const DEFAULT_PROFILES: readonly AgentProfile[] = [
  { id: "codex", label: "Codex CLI", provider: "codex", command: "codex", models: CODEX_MODELS.map((model) => model.id), modelOptions: CODEX_MODELS },
  { id: "claude", label: "Claude Code CLI", provider: "claude", command: "claude", models: CLAUDE_MODELS.map((model) => model.id), modelOptions: CLAUDE_MODELS },
  { id: "aioa", label: "AIOA", provider: "aioa", command: "", models: [] }
];

type StoredAgentProfile = AgentProfile | (Omit<AgentProfile, "provider"> & { provider: "qunshu" });

function normalizeStoredProfile(profile: StoredAgentProfile): AgentProfile {
  if (profile.provider !== "qunshu") return profile;
  return { ...profile, id: "aioa", label: "AIOA", provider: "aioa" };
}

function mergeProfiles(stored: readonly StoredAgentProfile[] | undefined): AgentProfile[] {
  const normalizedStored = stored?.map(normalizeStoredProfile);
  return DEFAULT_PROFILES.map((defaults) => {
    const saved = normalizedStored?.find((profile) => profile.id === defaults.id);
    const savedOptions = saved?.modelOptions ?? [];
    const modelOptions = [...defaults.modelOptions ?? [], ...savedOptions]
      .filter((candidate, index, all) => all.findIndex((item) => item.id === candidate.id) === index);
    const knownModels = modelOptions.map((model) => model.id);
    const models = [...new Set([...(saved?.models ?? []), ...defaults.models, ...knownModels])];
    return {
      ...defaults,
      ...saved,
      models,
      ...(modelOptions.length ? { modelOptions } : {})
    };
  }).concat(
    (normalizedStored ?? [])
      .filter((profile) => !DEFAULT_PROFILES.some((defaults) => defaults.id === profile.id))
      .map((profile) => ({ ...profile, models: [...profile.models] }))
  );
}

export class AgentProfileStore {
  private profiles: AgentProfile[];
  private selection: AgentSelection = {};

  constructor(private readonly state?: vscode.Memento) {
    const stored = state?.get<StoredAgentProfile[]>(STORAGE_KEY);
    this.profiles = mergeProfiles(stored);
    const storedSelection = state?.get<AgentSelection>(SELECTION_KEY) ?? {};
    this.selection = storedSelection.profileId === "qunshu"
      ? { ...storedSelection, profileId: "aioa" }
      : storedSelection;
  }

  list(): AgentProfile[] {
    return this.profiles.map((profile) => ({
      ...profile,
      models: [...profile.models],
      ...(profile.modelOptions ? { modelOptions: profile.modelOptions.map((model) => ({ ...model, reasoningEfforts: [...model.reasoningEfforts], speedTiers: [...model.speedTiers], serviceTiers: [...model.serviceTiers] })) } : {})
    }));
  }

  currentSelection(): AgentSelection {
    return { ...this.selection };
  }

  setSelection(selection: AgentSelection): void {
    this.selection = {
      ...(selection.profileId ? { profileId: selection.profileId } : {}),
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      ...(selection.speed ? { speed: selection.speed } : {}),
      ...(selection.serviceTier ? { serviceTier: selection.serviceTier } : {})
    };
    void this.state?.update(SELECTION_KEY, this.selection);
  }

  update(profile: AgentProfile): void {
    const modelOptions = profile.modelOptions ? [...profile.modelOptions] : [];
    for (const id of profile.models) {
      if (!modelOptions.some((model) => model.id === id)) {
        modelOptions.push({ id, label: id, reasoningEfforts: [], speedTiers: [], serviceTiers: [] });
      }
    }
    const normalized = {
      ...profile,
      models: [...new Set(profile.models)],
      ...(modelOptions.length ? { modelOptions } : {})
    };
    const index = this.profiles.findIndex((candidate) => candidate.id === profile.id);
    if (index < 0) this.profiles.push(normalized);
    else this.profiles[index] = normalized;
    void this.state?.update(STORAGE_KEY, this.profiles);
  }
}
