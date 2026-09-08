import type { AgentModelOption, AgentProfile, AgentSelection } from "./agentProfiles.js";

/** Display inherited values without persisting them as explicit CLI overrides. */
export function presentAgentSelection(profile: AgentProfile | undefined, selection: AgentSelection): {
  options: AgentModelOption[]; model: string; modelLabel: string; reasoningEffort: string; speed: string;
} {
  const options = [...(profile?.modelOptions ?? [])];
  for (const id of profile?.models ?? []) {
    if (!options.some((option) => option.id === id)) options.push({ id, label: id, reasoningEfforts: [], speedTiers: [], serviceTiers: [] });
  }
  const defaultModel = profile?.defaults?.model || options.find((option) => option.isDefault)?.id;
  const model = selection.model || defaultModel || "";
  if (model && !options.some((option) => option.id === model)) {
    options.push({ id: model, label: model, reasoningEfforts: [], speedTiers: [], serviceTiers: [] });
  }
  const selected = options.find((option) => option.id === model);
  const reasoningEffort = selection.reasoningEffort
    || (profile?.provider !== "deepseek-harness" || model === defaultModel ? profile?.defaults?.reasoningEffort : undefined)
    || selected?.defaultReasoningEffort || "";
  const speed = selection.speed || (selection.serviceTier === "priority" || selection.serviceTier === "fast"
    ? "fast" : selection.serviceTier === "default" ? "standard" : profile?.defaults?.speed) || "";
  return { options, model, modelLabel: selected?.label || "CLI setting", reasoningEffort, speed };
}
