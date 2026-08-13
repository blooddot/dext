import { performance } from "node:perf_hooks";
import { AxAdapter } from "./axAdapter.js";
import type { ContextResolver } from "./contextResolver.js";
import type { MethodRegistry } from "./registry.js";
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
  return values.map(requireCodeRef);
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
    const patch = args.patch;
    if (typeof patch !== "object" || patch === null || Array.isArray(patch) || patch.kind !== "patch") {
      throw new Error("code.apply requires the patch field from an EditResult.");
    }
    const changed = patch.changes.filter((change) => change.before !== change.after);
    if (changed.length) {
      throw new Error("Writing patches is not enabled in the deterministic first version.");
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

  constructor(
    private readonly registry: MethodRegistry,
    private readonly resolver: ContextResolver,
    private readonly ax = new AxAdapter(),
    handlers: Readonly<Record<string, DeterministicHandler>> = {}
  ) {
    this.handlers = { ...DEFAULT_HANDLERS, ...handlers };
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
    const handler = this.handlers[method.executor.handler];
    if (!handler) {
      throw new Error(`Executor '${method.executor.handler}' is not available.`);
    }
    const result = this.ax.validateOutput(contract, await handler(resolved));
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
