import { performance } from "node:perf_hooks";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AxAdapter } from "./axAdapter.js";
import type { ContextResolver } from "./contextResolver.js";
import type { MethodRegistry } from "./registry.js";
import type { AgentResult, CustomApiPlan, DirRef, McpRawResult, UiChoiceResult, UiConfirmResult, UiInputResult } from "./types.js";
import { WorkflowRuntime } from "./workflowRuntime.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import { patchResultFrom } from "./patch.js";
import type { AgentProfile, AgentSelection } from "../agentProfiles.js";
import { DefaultAgentRunner } from "./agentRouter.js";
import type { AgentRunner } from "./agentRunner.js";
import type {
  CodeRef,
  DextResult,
  ExecutionMetadata,
  InvocationAst,
  InvocationValue,
  ResolvedInvocation,
  RuntimeResponse
} from "./types.js";

export type DeterministicHandler = (
  invocation: ResolvedInvocation
) => DextResult | Promise<DextResult>;

function displayValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(displayValue).join(", ");
  }
  if (typeof value === "object" && value !== null && "uri" in value && typeof value.uri === "string") {
    return value.uri;
  }
  return JSON.stringify(value) ?? "";
}

function stringArgument(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringListArgument(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function validationValue(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "kind" in value && value.kind === "input"
    ? value
    : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgentResult(kind: string, value: unknown): DextResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Agent output must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === undefined) return { kind, ...record } as DextResult;
  if (record.kind !== kind) throw new Error(`Agent output kind '${typeof record.kind === "string" ? record.kind : "unknown"}' does not match '${kind}'.`);
  return record as unknown as DextResult;
}

function isMcpRawResult(value: DextResult): value is McpRawResult {
  return value.kind === "mcpRaw";
}

function adaptTypedMcpResult(result: McpRawResult, kind: string): DextResult {
  if (!result.structured) {
    throw new Error("A TypedDict custom API requires structuredContent from mcp.");
  }
  return { ...result.structured, kind } as DextResult;
}

const AGENT_METHODS = new Set(["ask", "agent", "skill"]);

function defaultWorkspace(root: string): DirRef {
  return { kind: "dirRef", uri: pathToFileURL(root).toString(), path: "." };
}

function insideWorkspace(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !/^[A-Za-z]:[\\/]/.test(path));
}

function workspaceCwd(root: string, workspace: unknown): string {
  if (!workspace || typeof workspace !== "object" || !("kind" in workspace) || workspace.kind !== "dirRef"
    || !("uri" in workspace) || typeof workspace.uri !== "string") {
    return root;
  }
  let candidate: string;
  try {
    const uri = new URL(workspace.uri);
    if (uri.protocol !== "file:") throw new Error();
    candidate = fileURLToPath(uri);
  } catch {
    throw new Error("ask/agent workspace must be a local workspace directory.");
  }
  if (!insideWorkspace(root, candidate)) {
    throw new Error("ask/agent workspace must stay inside the current project.");
  }
  return candidate;
}

function workspaceDirectory(workspace: unknown, root: string): DirRef {
  return workspace
    && typeof workspace === "object"
    && "kind" in workspace
    && workspace.kind === "dirRef"
    && "uri" in workspace
    && typeof workspace.uri === "string"
    && "path" in workspace
    && typeof workspace.path === "string"
    ? { kind: "dirRef", uri: workspace.uri, path: workspace.path }
    : defaultWorkspace(root);
}

function combineInstructions(...values: readonly (string | undefined)[]): string | undefined {
  const parts = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return parts.length ? parts.join("\n\n") : undefined;
}

export function usesAgentRunner(methodId: string): boolean {
  return AGENT_METHODS.has(methodId);
}

export const DEFAULT_HANDLERS: Readonly<Record<string, DeterministicHandler>> = {
  askRespond: ({ arguments: args }) => ({
    kind: "chat",
    text: typeof args.input === "string" ? args.input : ""
  }),
  agentRespond: ({ arguments: args }) => ({
    kind: "agent",
    text: typeof args.input === "string" ? args.input : "",
    summary: "No Agent profile is selected; no workspace changes were made."
  } satisfies AgentResult),
  applyPatch: ({ arguments: args }) => {
    const patch = patchResultFrom(args.result);
    const changed = patch.changes.filter((change) => change.before !== change.after);
    if (changed.length) {
      throw new Error("apply requires a workspace patch host for non-empty changes.");
    }
    return {
      kind: "apply",
      status: "unchanged",
      files: [],
      summary: "The patch contains no changes; no workspace files were written."
    };
  },
  printText: ({ arguments: args }) => ({
    kind: "print",
    text: typeof args.text === "string" ? args.text : "",
    ...(typeof args.label === "string" ? { label: args.label } : {})
  }),
  echoText: ({ arguments: args }) => ({
    kind: "text",
    text: Object.values(args).map(displayValue).join(" ")
  }),
  outlinePlan: ({ method, arguments: args }) => ({
    kind: "plan",
    title: method.title,
    steps: Object.entries(args).map(([name, value]) => ({
      title: name,
      detail: displayValue(value),
      status: "ready"
    }))
  }),
  previewPatch: ({ context, method }) => ({
    kind: "patch",
    title: method.title,
    changes: context.map((reference) => ({
      uri: reference.uri,
      before: reference.content,
      after: reference.content
    }))
  }),
  uiChoose: async ({ arguments: args, metadata }): Promise<UiChoiceResult> => {
    if (!metadata.ui) throw new Error("ui.choose requires an interactive Dext host.");
    const rawOptions = args.options;
    const options = (Array.isArray(rawOptions) ? rawOptions : [rawOptions])
      .filter((value): value is string => typeof value === "string");
    if (!options.length) throw new Error("ui.choose requires at least one option.");
    return metadata.ui.choose({
      label: stringArgument(args.label, "Choose"),
      options,
      multiple: args.multiple === true,
      allowCustom: args.allow_custom === true,
      ...(typeof args.custom_placeholder === "string" ? { customPlaceholder: args.custom_placeholder } : {})
    });
  },
  uiConfirm: async ({ arguments: args, metadata }): Promise<UiConfirmResult> => {
    if (!metadata.ui) throw new Error("ui.confirm requires an interactive Dext host.");
    return metadata.ui.confirm({
      message: stringArgument(args.message, ""),
      confirmLabel: stringArgument(args.confirm_label, "Continue"),
      cancelLabel: stringArgument(args.cancel_label, "Cancel")
    });
  },
  uiInput: async ({ arguments: args, metadata }): Promise<UiInputResult> => {
    if (!metadata.ui) throw new Error("ui.input requires an interactive Dext host.");
    return metadata.ui.input({
      label: stringArgument(args.label, "Input"),
      ...(typeof args.placeholder === "string" ? { placeholder: args.placeholder } : {}),
      multiline: args.multiline === true
    });
  },
  runSkill: () => {
    throw new Error("skill requires a configured Agent profile.");
  }
};

function mergeContext(resolved: readonly CodeRef[], supplemental: readonly CodeRef[]): CodeRef[] {
  const seen = new Set<string>();
  return [...resolved, ...supplemental].filter((reference) => {
    const key = `${reference.uri}|${reference.contentHash}|${JSON.stringify(reference.range ?? null)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class DextRuntime {
  private readonly handlers: Readonly<Record<string, DeterministicHandler>>;
  private readonly customPlans = new Map<string, CustomApiPlan>();
  private readonly agents = new Map<string, AgentProfile>();
  private agentSelection: AgentSelection = {};
  private agentRunner: AgentRunner;
  private workspaceRoot = process.cwd();
  private workspaceTrusted = false;
  private skillLoader: ((skill: string, workspace: DirRef) => Promise<{ instructions: string; sourcePath: string }>) | undefined;
  private ruleLoader: ((path: string) => Promise<string | undefined>) | undefined;
  private mcpCaller: ((tool: string, input: Record<string, unknown>) => Promise<DextResult>) | undefined;

  constructor(
    private readonly registry: MethodRegistry,
    private readonly resolver: ContextResolver,
    private readonly ax = new AxAdapter(),
    handlers: Readonly<Record<string, DeterministicHandler>> = {}
  ) {
    this.handlers = { ...DEFAULT_HANDLERS, ...handlers };
    this.agentRunner = new DefaultAgentRunner();
  }

  setCustomPlans(plans: ReadonlyMap<string, CustomApiPlan>): void {
    this.customPlans.clear();
    for (const [id, plan] of plans) this.customPlans.set(id, plan);
  }

  setAgentProfiles(profiles: readonly AgentProfile[]): void {
    this.agents.clear();
    for (const profile of profiles) this.agents.set(profile.id, profile);
  }

  setAgentSelection(selection: AgentSelection): void {
    this.agentSelection = { ...selection };
  }

  setAgentRunner(runner: AgentRunner): void {
    this.agentRunner = runner;
  }

  endAgentSession(sessionId: string): void {
    this.agentRunner.endSession?.(sessionId);
    this.agentRunner.endSession?.(`${sessionId}\u0000conversation`);
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  setWorkspaceTrusted(trusted: boolean): void {
    this.workspaceTrusted = trusted;
  }

  setSkillLoader(loader: (skill: string, workspace: DirRef) => Promise<{ instructions: string; sourcePath: string }>): void {
    this.skillLoader = loader;
  }

  setRuleLoader(loader: (path: string) => Promise<string | undefined>): void {
    this.ruleLoader = loader;
  }

  setMcpCaller(caller: (tool: string, input: Record<string, unknown>) => Promise<DextResult>): void {
    this.mcpCaller = caller;
  }

  async execute(
    invocation: InvocationAst,
    supplementalContext: readonly CodeRef[] = [],
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<RuntimeResponse> {
    if (metadata.signal?.aborted) throw new ExecutionCancelledError();
    const started = performance.now();
    const method = this.registry.get(invocation.method);
    if (!method) {
      throw new Error(`Unknown method '${invocation.method}'.`);
    }
    const argumentNames = new Set<string>();
    for (const argument of invocation.arguments) {
      if (argumentNames.has(argument.name)) {
        throw new Error(`Argument '${argument.name}' is provided more than once.`);
      }
      argumentNames.add(argument.name);
    }
    const contract = this.ax.compile(method);
    const rawArguments = Object.fromEntries(
      invocation.arguments.map((argument) => [argument.name, validationValue(argument.value)])
    ) as Record<string, InvocationValue>;
    this.ax.validateInput(contract, rawArguments);
    const resolvedInvocation = await this.resolver.resolve(invocation, method);
    const resolved = {
      ...resolvedInvocation,
      context: mergeContext(resolvedInvocation.context, supplementalContext),
      metadata
    };
    if (["skill", "ask", "agent"].includes(method.id) && !resolved.arguments.workspace) {
      resolved.arguments.workspace = defaultWorkspace(this.workspaceRoot);
    }
    let result: DextResult;
    if (method.executor.kind === "custom") {
      const plan = this.customPlans.get(method.executor.apiId);
      if (!plan) throw new Error(`Custom API '${method.executor.apiId}' is not available.`);
      const customMetadata: ExecutionMetadata = {
        ...metadata,
        ...(plan.agent ? { agent: plan.agent } : {}),
        ...(plan.model ? { model: plan.model } : {})
      };
      const workflowResult = await new WorkflowRuntime(this).executeValue(
        plan.program,
        Object.entries(resolved.arguments).map(([name, value]) => [name, value] as const),
        customMetadata
      );
      result = method.output.fields
        ? isMcpRawResult(workflowResult)
          ? adaptTypedMcpResult(workflowResult, method.output.kind)
          : (() => { throw new Error("A TypedDict custom API must return mcp(...)."); })()
        : workflowResult;
    } else if (method.id === "mcp") {
      if (!this.workspaceTrusted) {
        throw new Error("mcp requires a trusted local workspace.");
      }
      if (!this.mcpCaller) throw new Error("MCP registry is not configured.");
      const tool = resolved.arguments.tool;
      const input = resolved.arguments.input;
      if (typeof tool !== "string" || !isRecord(input)) {
        throw new Error("mcp requires a string tool and dictionary input.");
      }
      result = await this.mcpCaller(tool, input);
    } else {
      const profileId = metadata.agent ?? this.agentSelection.profileId;
      const profile = profileId ? this.agents.get(profileId) : undefined;
      // Mutation/application and presentation APIs stay deterministic. Only
      // semantic model operations are delegated to the selected Agent CLI.
      if (profile && usesAgentRunner(method.id)) {
        const agentWriteEnabled = method.id === "agent" && resolved.arguments.apply !== false;
        if (agentWriteEnabled && !this.workspaceTrusted) {
          throw new Error("agent(apply=true) requires a trusted local workspace.");
        }
        let runnerMetadata = metadata;
        if (method.id === "ask" || method.id === "agent") {
          const directory = workspaceDirectory(resolved.arguments.workspace, this.workspaceRoot);
          const skills = stringListArgument(resolved.arguments.skills, "skills");
          const skillInstructions: string[] = [];
          if (skills.length) {
            if (!this.skillLoader) throw new Error("Agent call skill loading is not configured.");
            for (const skill of skills) {
              const loaded = await this.skillLoader(skill, directory);
              skillInstructions.push([
                `Follow the skill '${skill}' from ${loaded.sourcePath} for this ${method.id} call.`,
                loaded.instructions
              ].join("\n\n"));
            }
          }
          const rules = stringListArgument(resolved.arguments.rules, "rules");
          const ruleInstructions: string[] = [];
          if (rules.length) {
            if (!this.workspaceTrusted) {
              throw new Error("rules require a trusted local workspace.");
            }
            const rulesRoot = join(this.workspaceRoot, ".dext", "rules");
            for (const rule of rules) {
              if (isAbsolute(rule) || rule.includes("\0")) {
                throw new Error("rules must use paths relative to .dext/rules.");
              }
              const resolvedPath = resolve(rulesRoot, rule);
              if (!insideWorkspace(this.workspaceRoot, resolvedPath) || !insideWorkspace(rulesRoot, resolvedPath)) {
                throw new Error("rules must stay below .dext/rules.");
              }
              try {
                const content = this.ruleLoader
                  ? await this.ruleLoader(resolvedPath)
                  : await readFile(resolvedPath, "utf8");
                if (content === undefined) throw new Error("file not found");
                ruleInstructions.push(`Apply rule '${rule}':\n\n${content}`);
              } catch (error) {
                throw new Error(`Unable to read rule '${rule}': ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
          const callInstruction = combineInstructions(
            combineInstructions(undefined, ...skillInstructions),
            ...ruleInstructions
          );
          const instruction = combineInstructions(metadata.instruction, callInstruction);
          if (instruction) runnerMetadata = { ...metadata, instruction };
        }
        if (method.id === "skill") {
          if (!this.skillLoader) throw new Error("Skill discovery is not configured.");
          const workspace = resolved.arguments.workspace;
          const directory: DirRef = workspace
            && typeof workspace === "object"
            && "kind" in workspace
            && workspace.kind === "dirRef"
            && "uri" in workspace
            && typeof workspace.uri === "string"
            && "path" in workspace
            && typeof workspace.path === "string"
            ? { kind: "dirRef", uri: workspace.uri, path: workspace.path }
            : defaultWorkspace(this.workspaceRoot);
          const skill = resolved.arguments.skill;
          if (typeof skill !== "string") throw new Error("skill requires a skill name.");
          const loaded = await this.skillLoader(skill, directory);
          runnerMetadata = {
            ...metadata,
            instruction: [
              `Execute the standard skill '${skill}' from ${loaded.sourcePath}.`,
              "Follow its instructions for the direct input below. Do not expose private reasoning.",
              "SKILL.md:",
              loaded.instructions
            ].join("\n\n")
          };
        }
        const raw = await this.agentRunner.run({
          profile,
          ...(metadata.model || this.agentSelection.model ? { model: metadata.model ?? this.agentSelection.model } : {}),
          ...((metadata.reasoningEffort ?? this.agentSelection.reasoningEffort) ? { reasoningEffort: metadata.reasoningEffort ?? this.agentSelection.reasoningEffort } : {}),
          ...((metadata.speed ?? this.agentSelection.speed) ? { speed: metadata.speed ?? this.agentSelection.speed } : {}),
          ...((metadata.serviceTier ?? this.agentSelection.serviceTier) ? { serviceTier: metadata.serviceTier ?? this.agentSelection.serviceTier } : {}),
          cwd: ["ask", "agent"].includes(method.id)
            ? workspaceCwd(this.workspaceRoot, resolved.arguments.workspace)
            : this.workspaceRoot,
          method,
          resolved,
          contract,
          metadata: runnerMetadata,
          allowWorkspaceWrite: agentWriteEnabled,
          ...(metadata.signal ? { signal: metadata.signal } : {}),
          ...(runnerMetadata.onAgentEvent ? { onEvent: runnerMetadata.onAgentEvent } : {})
        });
        result = normalizeAgentResult(method.output.kind, raw);
      } else {
        const handler = this.handlers[method.executor.handler];
        if (!handler) {
          throw new Error(`Executor '${method.executor.handler}' is not available.`);
        }
        result = await handler(resolved);
      }
    }
    result = this.ax.validateOutput(contract, result);
    return {
      invocation,
      method: {
        id: method.id,
        title: method.title,
        kind: method.kind,
        source: method.source
      },
      result,
      durationMs: performance.now() - started,
      ...(metadata.instruction ? { instruction: metadata.instruction } : {})
    };
  }

  /** Runs a normal Agent or Ask turn without compiling it as Dext code or
   * imposing a typed API response on the selected provider. */
  async executeConversation(
    mode: "agent" | "ask",
    input: string,
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<RuntimeResponse> {
    if (metadata.signal?.aborted) throw new ExecutionCancelledError();
    const text = input.trim();
    if (!text) throw new Error("Enter a message before sending it.");
    const method = this.registry.get(mode);
    if (!method) throw new Error(`Built-in conversation mode '${mode}' is not available.`);
    const profileId = metadata.agent ?? this.agentSelection.profileId ?? this.agents.keys().next().value;
    const profile = profileId ? this.agents.get(profileId) : undefined;
    if (!profile) throw new Error("Choose an Agent before starting a conversation.");
    if (!this.agentRunner.runConversation) {
      throw new Error(`Agent '${profile.label}' does not support normal conversation mode.`);
    }
    const allowWorkspaceWrite = mode === "agent";
    if (allowWorkspaceWrite && !this.workspaceTrusted) {
      throw new Error("Agent mode requires a trusted local workspace.");
    }
    const started = performance.now();
    const sessionId = metadata.agentSessionId
      ? `${metadata.agentSessionId}\u0000conversation`
      : undefined;
    const response = await this.agentRunner.runConversation({
      profile,
      ...(metadata.model || this.agentSelection.model ? { model: metadata.model ?? this.agentSelection.model } : {}),
      ...((metadata.reasoningEffort ?? this.agentSelection.reasoningEffort) ? { reasoningEffort: metadata.reasoningEffort ?? this.agentSelection.reasoningEffort } : {}),
      ...((metadata.speed ?? this.agentSelection.speed) ? { speed: metadata.speed ?? this.agentSelection.speed } : {}),
      ...((metadata.serviceTier ?? this.agentSelection.serviceTier) ? { serviceTier: metadata.serviceTier ?? this.agentSelection.serviceTier } : {}),
      cwd: this.workspaceRoot,
      input: text,
      mode,
      metadata: { ...metadata, ...(sessionId ? { agentSessionId: sessionId } : {}) },
      allowWorkspaceWrite,
      ...(metadata.signal ? { signal: metadata.signal } : {}),
      ...(metadata.onAgentEvent ? { onEvent: metadata.onAgentEvent } : {})
    });
    return {
      invocation: {
        kind: "invocation",
        method: mode,
        arguments: [{ name: "input", value: text }],
        source: "chat"
      },
      method: { id: mode, title: method.title, kind: method.kind, source: method.source },
      result: { kind: "chat", text: response },
      durationMs: performance.now() - started
    };
  }

  async executeSerial(
    invocations: readonly InvocationAst[],
    supplementalContext: readonly CodeRef[] = [],
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<RuntimeResponse[]> {
    const responses: RuntimeResponse[] = [];
    for (const invocation of invocations) {
      responses.push(await this.execute(invocation, supplementalContext, metadata));
    }
    return responses;
  }
}
