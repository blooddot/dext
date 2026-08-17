import { createHash } from "node:crypto";
import type {
  CodeRef,
  ContextReference,
  DirectoryReference,
  DirRef,
  InterpolatedInput,
  InvocationValue,
  Range,
  RegisteredCallable,
  ResolvedInvocation,
  InvocationAst
} from "./types.js";

export interface TextSnapshot {
  uri: string;
  content: string;
  version: number;
  range?: Range;
  symbol?: string;
}

export interface ContextHost {
  selection(): Promise<TextSnapshot | undefined>;
  activeFile(): Promise<TextSnapshot | undefined>;
  file(path: string): Promise<TextSnapshot | undefined>;
  symbol(name: string): Promise<TextSnapshot | undefined>;
  dir(path: string): Promise<DirRef | undefined>;
}

export function toCodeRef(snapshot: TextSnapshot): CodeRef {
  return {
    kind: "codeRef",
    uri: snapshot.uri,
    ...(snapshot.range ? { range: snapshot.range } : {}),
    ...(snapshot.symbol ? { symbol: snapshot.symbol } : {}),
    documentVersion: snapshot.version,
    contentHash: createHash("sha256").update(snapshot.content).digest("hex"),
    content: snapshot.content
  };
}

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

function isInterpolatedInput(value: InvocationValue): value is InterpolatedInput {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "kind" in value && value.kind === "interpolatedInput";
}

function isRecord(value: InvocationValue): value is { [key: string]: InvocationValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectoryPart(value: InterpolatedInput["parts"][number]): value is DirectoryReference {
  return typeof value === "object" && value !== null && value.kind === "dir" && "path" in value;
}

function isContextPart(value: InterpolatedInput["parts"][number]): value is ContextReference {
  return typeof value === "object" && value !== null
    && ["selection", "activeFile", "file", "symbol"].includes(value.kind);
}

function inlineCodeReference(value: CodeRef): string {
  const range = value.range
    ? ` range="${value.range.start.line + 1}:${value.range.start.character + 1}-${value.range.end.line + 1}:${value.range.end.character + 1}"`
    : "";
  const symbol = value.symbol ? ` symbol=${JSON.stringify(value.symbol)}` : "";
  return `<dext-ref uri=${JSON.stringify(value.uri)}${range}${symbol}>\n${value.content}\n</dext-ref>`;
}

function inlineDirectoryReference(value: DirRef): string {
  return `<dext-dir uri=${JSON.stringify(value.uri)} path=${JSON.stringify(value.path)} />`;
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

  async resolveReferences(references: readonly ContextReference[]): Promise<CodeRef[]> {
    const resolved: CodeRef[] = [];
    for (const reference of references) resolved.push(await this.resolveReference(reference));
    return resolved;
  }

  async resolveDirectory(reference: DirectoryReference): Promise<DirRef> {
    const directory = await this.host.dir(reference.path);
    if (!directory) throw new Error("Unable to resolve ref.dir.");
    return directory;
  }

  private async resolveInterpolatedInput(value: InterpolatedInput): Promise<{ input: string; context: CodeRef[] }> {
    const parts: string[] = [];
    const context: CodeRef[] = [];
    for (const part of value.parts) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (isDirectoryPart(part)) {
        parts.push(inlineDirectoryReference(await this.resolveDirectory(part)));
      } else if (isContextPart(part)) {
        const reference = await this.resolveReference(part);
        context.push(reference);
        parts.push(inlineCodeReference(reference));
      } else {
        parts.push(`<dext-result>${JSON.stringify(part)}</dext-result>`);
      }
    }
    return { input: parts.join(""), context };
  }

  private async resolveValue(value: InvocationValue, context: CodeRef[]): Promise<InvocationValue> {
    if (isInterpolatedInput(value)) {
      const resolved = await this.resolveInterpolatedInput(value);
      context.push(...resolved.context);
      return resolved.input;
    }
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
