import type { AgentProfile, AgentSelection } from "../agentProfiles.js";
import type { CallableDefinition, ExecutionMetadata, FieldDefinition } from "./types.js";

export const CLI_BUILTIN_IDS = new Set(["agent", "ask", "plan", "skill", "create"]);
export const CODEX_REASONING = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const CLI_SPEEDS = ["standard", "fast"];

export function builtinCliFields(profiles: readonly AgentProfile[] = []): FieldDefinition[] {
  const codex = profiles.find((profile) => profile.id === "codex");
  const models = [...new Set([...(codex?.models ?? []), ...(codex?.modelOptions?.map((model) => model.id) ?? [])])];
  return [
    { name: "cli", type: "enum", values: ["codex", "claude", "deepseek-harness"], description: "CLI for this call. When set, omitted model options use CLI defaults, not Input settings. Omit both cli and model to use the current Input selection." },
    {
      name: "model", type: "enum", values: ["sonnet", "opus"], accepts: ["object"],
      description: 'Claude: "sonnet" or "opus". Codex: {"model": "model-id", "reasoning": "high", "speed": "standard"}. Harness: {"model": "opaque-option-id", "reasoning": "high"}. Optional; without cli, uses the CLI selected in Input.',
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
  if (!CLI_BUILTIN_IDS.has(method.id) || (cli !== "codex" && cli !== "claude" && cli !== "deepseek-harness")) return method;
  return {
    ...method,
    input: method.input.map((field) => {
      if (field.name !== "model") return field;
      if (cli === "deepseek-harness") return { ...field, type: "object", accepts: [], values: undefined, properties: [
        { name: "model", type: "string", required: true, description: "Opaque Harness model option from Configure Agent." },
        { name: "reasoning", type: "string", description: "Advertised Harness reasoning effort." }
      ] };
      return cli === "codex" ? { ...field, type: "object", accepts: [], values: undefined }
        : { ...field, type: "enum", accepts: [], properties: undefined };
    })
  };
}

/** Explicit per-call selection wins over decorator and composer settings.
 * Never carry a Codex model/effort into Claude (or vice versa). */
export function builtinCliMetadata(
  args: Record<string, unknown>, profiles: readonly AgentProfile[],
  selection: AgentSelection, metadata: Readonly<ExecutionMetadata>
): ExecutionMetadata {
  if (args.cli === undefined && args.model === undefined) return metadata;
  const cli = args.cli;
  const explicitCli = typeof cli === "string";
  const id = explicitCli ? cli : selection.profileId ?? metadata.agent;
  const profile = profiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`CLI '${id ?? "default"}' is not configured. Choose cli="codex", cli="claude", or cli="deepseek-harness".`);
  const sameSelection = id === selection.profileId;
  const inheritedModel = !explicitCli && sameSelection ? selection.model ?? "" : "";
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
    } else if (profile.provider === "deepseek-harness") {
      if (!args.model || typeof args.model !== "object" || Array.isArray(args.model)) throw new Error("Harness model must be an object with model and optional reasoning.");
      const options = args.model as Record<string, unknown>;
      if (Object.keys(options).some((key) => !["model", "reasoning"].includes(key))) throw new Error("Unknown Harness model option.");
      if (typeof options.model !== "string" || !options.model.trim()) throw new Error("Harness model.model must be a non-empty option ID.");
      if (options.reasoning !== undefined && typeof options.reasoning !== "string") throw new Error("Harness reasoning must be a string.");
      model = options.model; reasoning = options.reasoning;
    } else throw new Error("Unsupported Agent backend.");
  }
  const inherit = !explicitCli && sameSelection && model === inheritedModel;
  return {
    ...metadata, agent: profile.id, model,
    reasoningEffort: reasoning ?? (inherit ? selection.reasoningEffort ?? "" : ""),
    speed: speed ?? (inherit ? selection.speed ?? "" : ""),
    serviceTier: speed ? "" : inherit ? selection.serviceTier ?? "" : ""
  };
}
