import type { AgentProfile, AgentSelection } from "../agentProfiles.js";
import type { CallableDefinition, ExecutionMetadata, FieldDefinition } from "./types.js";

export const CLI_BUILTIN_IDS = new Set(["agent", "ask", "plan", "skill", "create"]);
export const CODEX_REASONING = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const CLI_SPEEDS = ["standard", "fast"];

export function builtinCliFields(profiles: readonly AgentProfile[] = []): FieldDefinition[] {
  const codex = profiles.find((profile) => profile.id === "codex");
  const models = [...new Set([...(codex?.models ?? []), ...(codex?.modelOptions?.map((model) => model.id) ?? [])])];
  return [
    { name: "cli", type: "enum", values: ["codex", "claude"], description: "CLI for this call. Omit to use the current Agent selection." },
    {
      name: "model", type: "enum", values: ["sonnet", "opus"], accepts: ["object"],
      description: 'Claude: "sonnet" or "opus". Codex: {"model": "model-id", "reasoning": "high", "speed": "standard"}. Omit to use the selected CLI defaults.',
      properties: [
        { name: "model", type: models.length ? "enum" : "string", ...(models.length ? { values: models } : {}), required: true, description: "Model ID from the Codex model list." },
        { name: "reasoning", type: "enum", values: [...CODEX_REASONING], description: "Reasoning effort for this call." },
        { name: "speed", type: "enum", values: [...CLI_SPEEDS], description: "Standard or Fast processing for this call." }
      ]
    }
  ];
}

/** The same provider-dependent contract is used by compilation, completion,
 * and execution; callers with a dynamic CLI retain the union until runtime. */
export function specializeBuiltinCli<T extends CallableDefinition>(method: T, cli: unknown): T {
  if (!CLI_BUILTIN_IDS.has(method.id) || !["codex", "claude"].includes(String(cli))) return method;
  return {
    ...method,
    input: method.input.map((field) => field.name !== "model" ? field : cli === "codex"
      ? { ...field, type: "object", accepts: [], values: undefined }
      : { ...field, type: "enum", accepts: [], properties: undefined })
  };
}

/** Explicit per-call selection wins over decorator and composer settings.
 * Never carry a Codex model/effort into Claude (or vice versa). */
export function builtinCliMetadata(
  args: Record<string, unknown>, profiles: readonly AgentProfile[],
  selection: AgentSelection, metadata: Readonly<ExecutionMetadata>
): ExecutionMetadata {
  if (args.cli === undefined && args.model === undefined) return metadata;
  const inheritedId = metadata.agent ?? selection.profileId;
  const id = typeof args.cli === "string" ? args.cli : inheritedId;
  const profile = profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`CLI '${id ?? "default"}' is not configured. Choose cli="codex" or cli="claude".`);
  const sameSelection = id === selection.profileId;
  const inheritedModel = id === inheritedId ? metadata.model ?? (sameSelection ? selection.model ?? "" : "") : "";
  let model = inheritedModel;
  let reasoning: string | undefined;
  let speed: string | undefined;
  if (args.model !== undefined) {
    if (profile.provider === "claude") {
      if (args.model !== "sonnet" && args.model !== "opus") throw new Error('Claude model must be "sonnet" or "opus".');
      model = args.model;
    } else if (profile.provider === "codex") {
      if (!args.model || typeof args.model !== "object" || Array.isArray(args.model)) throw new Error("Codex model must be an object with model, reasoning, and speed fields.");
      const options = args.model as Record<string, unknown>;
      const unknown = Object.keys(options).find((key) => !["model", "reasoning", "speed"].includes(key));
      if (unknown) throw new Error(`Unknown Codex model option '${unknown}'.`);
      // The provider-specialized input schema validates types and enum values.
      model = options.model as string;
      if (!model?.trim()) throw new Error("Codex model.model must be a non-empty model ID.");
      reasoning = options.reasoning as string | undefined;
      speed = options.speed as string | undefined;
    } else throw new Error("The model argument supports only Codex and Claude CLI.");
  }
  const inherit = id === inheritedId && model === inheritedModel;
  return {
    ...metadata, agent: profile.id, model,
    reasoningEffort: reasoning ?? (inherit ? metadata.reasoningEffort ?? (sameSelection ? selection.reasoningEffort ?? "" : "") : ""),
    speed: speed ?? (inherit ? metadata.speed ?? (sameSelection ? selection.speed ?? "" : "") : ""),
    serviceTier: speed ? "" : inherit ? metadata.serviceTier ?? (sameSelection ? selection.serviceTier ?? "" : "") : ""
  };
}
