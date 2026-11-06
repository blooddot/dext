import type { AgentModelOption } from "../contracts/agent.js";
import { piObject, type PiModel, type PiSessionBinding, type PiState } from "../contracts/pi.js";

export function piModelId(model: Pick<PiModel, "provider" | "id">): string { return `${model.provider}/${model.id}`; }
export function parsePiModelId(value: string): Pick<PiModel, "provider" | "id"> {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || value.trim() !== value) throw new Error("Pi model must use provider/modelId. Refresh models using Configure Agent.");
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
export function piModels(value: unknown): PiModel[] {
  if (!Array.isArray(value)) throw new Error("Pi returned an invalid model directory.");
  return value.map((entry) => {
    const model = piObject(entry);
    if (typeof model.provider !== "string" || !model.provider || model.provider.includes("/") || typeof model.id !== "string" || !model.id) throw new Error("Pi returned an invalid model identifier.");
    return { provider: model.provider, id: model.id,
      ...(typeof model.name === "string" ? { name: model.name } : {}),
      ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
      ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}) };
  });
}
export function piModelOptions(models: readonly PiModel[], defaults: PiState, levels: ReadonlyMap<string, readonly string[]> = new Map()): AgentModelOption[] {
  const defaultId = defaults.model ? piModelId(defaults.model) : undefined;
  return models.map((model) => {
    const id = piModelId(model);
    return { id, label: model.name || model.id, group: model.provider, isDefault: id === defaultId,
      ...(id === defaultId && defaults.thinkingLevel ? { defaultReasoningEffort: defaults.thinkingLevel } : {}),
      reasoningEfforts: [...(levels.get(id) ?? (model.reasoning === false ? ["off"] : []))], speedTiers: [], serviceTiers: [] };
  });
}
export function piThinkingLevels(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item)) throw new Error("Pi does not advertise valid thinking levels.");
  return [...new Set(value as string[])];
}
export function encodePiSession(value: PiSessionBinding): string { return `pi1:${encodeURIComponent(JSON.stringify(value))}`; }
export function decodePiSession(value: string): PiSessionBinding {
  try {
    const parsed = piObject(JSON.parse(decodeURIComponent(value.startsWith("pi1:") ? value.slice(4) : "")));
    if (typeof parsed.path === "string" && parsed.path && typeof parsed.binding === "string" && parsed.binding) return { path: parsed.path, binding: parsed.binding };
  } catch { /* Report one stable error, without echoing stored content. */ }
  throw new Error("The stored Pi session binding is invalid. Start a new conversation.");
}
