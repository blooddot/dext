import { performance } from "node:perf_hooks";
import { AxAdapter } from "./axAdapter.js";
import type { ContextResolver } from "./contextResolver.js";
import type { MethodRegistry } from "./registry.js";
import type { CustomApiPlan } from "./types.js";
import { WorkflowRuntime } from "./workflowRuntime.js";
import { isDextResult, resultToCodeRefs } from "./resultSerialization.js";
import { patchResultFrom } from "./patch.js";
import type { AgentProfile, AgentSelection } from "../agentProfiles.js";
import { DefaultAgentRunner } from "./agentRouter.js";
import type { AgentRunner } from "./agentRunner.js";
import type {
  CodeRef,
  DextResult,
  ExecutionMetadata,
  InvocationAst,
  ResolvedInvocation,
  RuntimeResponse
} from "./types.js";

export type DeterministicHandler = (
  invocation: ResolvedInvocation
) => DextResult | Promise<DextResult>;

function requireCodeRef(value: unknown): CodeRef {
  if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "codeRef") {
    throw new Error("This method requires a resolvable code reference.");
  }
  return value as CodeRef;
}

function requireCodeRefs(value: unknown): CodeRef[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (isDextResult(item)) return resultToCodeRefs(item);
    return [requireCodeRef(item)];
  });
}

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

function normalizeAgentResult(kind: string, value: unknown): DextResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Agent output must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === undefined) return { kind, ...record } as DextResult;
  if (record.kind !== kind) throw new Error(`Agent output kind '${typeof record.kind === "string" ? record.kind : "unknown"}' does not match '${kind}'.`);
  return record as unknown as DextResult;
}

function previewTargetIndex(uri: string): number | undefined {
  const match = /(?:^|[\\/])target-(\d+)(?:[\\/]|$)/.exec(uri);
  return match ? Number(match[1]) - 1 : undefined;
}

function normalizeAgentEdit(result: DextResult, targets: readonly CodeRef[]): DextResult {
  if (result.kind !== "edit") return result;
  const used = new Set<number>();
  const changes = result.patch.changes.map((change, changeIndex) => {
    let targetIndex = targets.findIndex((target) => target.uri === change.uri);
    if (targetIndex < 0) targetIndex = previewTargetIndex(change.uri) ?? -1;
    if (targetIndex < 0 && targets.length === 1) targetIndex = 0;
    if (targetIndex < 0) targetIndex = targets.findIndex((_, index) => !used.has(index));
    const target = targets[targetIndex];
    if (!target) throw new Error(`code.edit returned a change for an unknown target '${change.uri || changeIndex + 1}'.`);
    used.add(targetIndex);
    return {
      uri: target.uri,
      before: target.content,
      after: change.after,
      ...(target.range ? { range: target.range } : {}),
      documentVersion: target.documentVersion,
      contentHash: target.contentHash
    };
  });
  return {
    ...result,
    files: [...targets],
    patch: { ...result.patch, changes }
  };
}

const AGENT_METHODS = new Set(["chat", "code.explain", "code.edit", "code.review"]);

export function usesAgentRunner(methodId: string): boolean {
  return AGENT_METHODS.has(methodId);
}

export const DEFAULT_HANDLERS: Readonly<Record<string, DeterministicHandler>> = {
  chatRespond: ({ arguments: args }) => ({
    kind: "chat",
    text: typeof args.message === "string" ? args.message : ""
  }),
  explainCode: ({ arguments: args }) => {
    const files = requireCodeRefs(args.target);
    const lines = files.reduce((total, file) => total + file.content.split(/\r?\n/).length, 0);
    return {
      kind: "explain",
      text: `Resolved ${lines} lines from ${files.length} code reference(s). A model adapter is required for semantic explanation.`,
      files
    };
  },
  editCode: ({ arguments: args, method }) => {
    const files = requireCodeRefs(args.target);
    return {
      kind: "edit",
      summary: "No changes generated: the deterministic executor does not invent semantic edits.",
      patch: {
        kind: "patch",
        title: method.title,
        changes: files.map((file) => ({ uri: file.uri, before: file.content, after: file.content }))
      },
      files
    };
  },
  contextSnapshot: ({ arguments: args }) => {
    const target = requireCodeRef(args.target);
    const extension = /\.([A-Za-z0-9]+)$/.exec(target.uri)?.[1] ?? "text";
    return {
      kind: "code",
      code: target.content,
      language: extension,
      title: target.symbol ?? target.uri
    };
  },
  reviewCode: ({ arguments: args }) => {
    const targets = requireCodeRefs(args.target);
    const lines = targets.reduce((total, target) => total + target.content.split(/\r?\n/).length, 0);
    return {
      kind: "review",
      status: "warning",
      summary: `Resolved ${lines} lines for deterministic review.`,
      findings: [
        {
          severity: "warning",
          message: "The deterministic first-version executor validates context only; connect a model adapter for semantic findings.",
          ...(targets[0] ? { uri: targets[0].uri } : {})
        }
      ]
    };
  },
  applyPatch: ({ arguments: args }) => {
    const patch = patchResultFrom(args.result);
    const changed = patch.changes.filter((change) => change.before !== change.after);
    if (changed.length) {
      throw new Error("code.apply requires a workspace patch host for non-empty changes.");
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
  })
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
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  async execute(
    invocation: InvocationAst,
    supplementalContext: readonly CodeRef[] = [],
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<RuntimeResponse> {
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
      invocation.arguments.map((argument) => [argument.name, argument.value])
    );
    this.ax.validateInput(contract, rawArguments);
    const resolvedInvocation = await this.resolver.resolve(invocation, method);
    const resolved = {
      ...resolvedInvocation,
      context: mergeContext(resolvedInvocation.context, supplementalContext),
      metadata
    };
    let result: DextResult;
    if (method.executor.kind === "custom") {
      const plan = this.customPlans.get(method.executor.apiId);
      if (!plan) throw new Error(`Custom API '${method.executor.apiId}' is not available.`);
      const customMetadata: ExecutionMetadata = {
        ...metadata,
        ...(plan.agent ? { agent: plan.agent } : {}),
        ...(plan.model ? { model: plan.model } : {})
      };
      result = await new WorkflowRuntime(this).executeValue(
        plan.program,
        Object.entries(resolved.arguments).map(([name, value]) => [name, value] as const),
        customMetadata
      );
    } else {
      const profileId = metadata.agent ?? this.agentSelection.profileId;
      const profile = profileId ? this.agents.get(profileId) : undefined;
      // Mutation/application and presentation APIs stay deterministic. Only
      // semantic model operations are delegated to the selected Agent CLI.
      if (profile && usesAgentRunner(method.id)) {
        const raw = await this.agentRunner.run({
          profile,
          ...(metadata.model || this.agentSelection.model ? { model: metadata.model ?? this.agentSelection.model } : {}),
          ...((metadata.reasoningEffort ?? this.agentSelection.reasoningEffort) ? { reasoningEffort: metadata.reasoningEffort ?? this.agentSelection.reasoningEffort } : {}),
          ...((metadata.speed ?? this.agentSelection.speed) ? { speed: metadata.speed ?? this.agentSelection.speed } : {}),
          ...((metadata.serviceTier ?? this.agentSelection.serviceTier) ? { serviceTier: metadata.serviceTier ?? this.agentSelection.serviceTier } : {}),
          cwd: this.workspaceRoot,
          method,
          resolved,
          contract,
          metadata,
          ...(metadata.onAgentEvent ? { onEvent: metadata.onAgentEvent } : {})
        });
        result = normalizeAgentResult(method.output.kind, raw);
        if (method.id === "code.edit") {
          result = normalizeAgentEdit(result, requireCodeRefs(resolved.arguments.target));
        }
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
