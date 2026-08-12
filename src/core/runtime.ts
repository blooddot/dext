import { performance } from "node:perf_hooks";
import { AxAdapter } from "./axAdapter.js";
import type { ContextResolver } from "./contextResolver.js";
import type { MethodRegistry } from "./registry.js";
import type {
  CodeRef,
  DextResult,
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

const DEFAULT_HANDLERS: Readonly<Record<string, DeterministicHandler>> = {
  chatRespond: ({ arguments: args }) => ({
    kind: "text",
    text: typeof args.message === "string" ? args.message : ""
  }),
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
    const target = requireCodeRef(args.target);
    const lines = target.content.split(/\r?\n/).length;
    return {
      kind: "review",
      summary: `Resolved ${lines} lines for ${typeof args.focus === "string" ? args.focus : "correctness"} review.`,
      findings: [
        {
          severity: "info",
          message: "The deterministic first-version executor validates context only; connect a model adapter for semantic findings.",
          uri: target.uri
        }
      ]
    };
  },
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
    supplementalContext: readonly CodeRef[] = []
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
      context: mergeContext(resolvedInvocation.context, supplementalContext)
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
      durationMs: performance.now() - started
    };
  }
}
