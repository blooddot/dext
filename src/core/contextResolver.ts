import { createHash } from "node:crypto";
import type {
  CodeRef,
  ContextReference,
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
  return typeof value === "object" && !Array.isArray(value) && "kind" in value;
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
      throw new Error(`Unable to resolve @${reference.kind}.`);
    }
    return toCodeRef(snapshot);
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
      if (Array.isArray(value)) {
        const resolved: (InvocationValue | CodeRef)[] = [];
        for (const entry of value) {
          if (isContextReference(entry)) {
            const reference = await this.resolveReference(entry);
            resolved.push(reference);
            context.push(reference);
          } else {
            resolved.push(entry);
          }
        }
        args[field.name] = resolved as CodeRef[];
      } else if (isContextReference(value)) {
        const reference = await this.resolveReference(value);
        args[field.name] = reference;
        context.push(reference);
      } else {
        args[field.name] = value;
      }
    }
    return { invocation, method, arguments: args, context };
  }
}
