import type {
  CodeRef,
  ContextReference,
  DirectoryReference,
  DirRef,
  InvocationValue,
  RegisteredCallable,
  ResolvedInvocation,
  InvocationAst
} from "../../../shared/contracts/types.js";
import type { ContextHost, TextSnapshot } from "../../../shared/contracts/context.js";
import { toCodeRef } from "../../../platform/node/codeRef.js";

function isContextReference(value: InvocationValue): value is ContextReference {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "kind" in value
    && typeof value.kind === "string"
    && ["selection", "activeFile", "file", "symbol"].includes(value.kind);
}

function isCodeRef(value: InvocationValue): value is CodeRef {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "kind" in value && value.kind === "codeRef";
}

function isDirectoryReference(value: InvocationValue): value is DirectoryReference {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "kind" in value && value.kind === "dir";
}

function isDirRef(value: InvocationValue): value is DirRef {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "kind" in value && value.kind === "dirRef";
}

function isRecord(value: InvocationValue): value is { [key: string]: InvocationValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ContextResolver {
  constructor(private readonly host: ContextHost) {}

  async resolveReference(reference: ContextReference): Promise<CodeRef> {
    let snapshot: TextSnapshot | undefined;
    switch (reference.kind) {
      case "selection":
        snapshot = await this.host.selection();
        break;
      case "activeFile":
        snapshot = await this.host.activeFile();
        break;
      case "file":
        snapshot = await this.host.file(reference.path);
        break;
      case "symbol":
        snapshot = await this.host.symbol(reference.name);
        break;
    }
    if (!snapshot) {
      throw new Error(`Unable to resolve ref.${reference.kind === "activeFile" ? "active_file" : reference.kind}.`);
    }
    return toCodeRef(snapshot);
  }

  async resolveDirectory(reference: DirectoryReference): Promise<DirRef> {
    const directory = await this.host.dir(reference.path);
    if (!directory) throw new Error("Unable to resolve ref.dir.");
    return directory;
  }

  private async resolveValue(value: InvocationValue, context: CodeRef[]): Promise<InvocationValue> {
    if (isCodeRef(value)) {
      context.push(value);
      return value;
    }
    if (isContextReference(value)) {
      const resolved = await this.resolveReference(value);
      context.push(resolved);
      return resolved;
    }
    if (isDirectoryReference(value)) return this.resolveDirectory(value);
    if (isDirRef(value)) return value;
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => this.resolveValue(entry, context)));
    }
    if (isRecord(value)) {
      const entries = await Promise.all(Object.entries(value).map(async ([key, entry]) => [
        key,
        await this.resolveValue(entry, context)
      ] as const));
      return Object.fromEntries(entries);
    }
    return value;
  }

  async resolve(
    invocation: InvocationAst,
    method: RegisteredCallable
  ): Promise<ResolvedInvocation> {
    const args: ResolvedInvocation["arguments"] = {};
    const context: CodeRef[] = [];
    for (const field of method.input) {
      const provided = invocation.arguments.find((argument) => argument.name === field.name)?.value;
      const value = provided ?? field.default;
      if (value === undefined) {
        continue;
      }
      args[field.name] = await this.resolveValue(value, context);
    }
    return { invocation, method, arguments: args, context, metadata: {} };
  }
}
