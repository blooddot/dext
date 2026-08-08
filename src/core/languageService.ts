import { DslSyntaxError, parseInvocation } from "./dsl.js";
import type { MethodRegistry } from "./registry.js";
import type {
  ContextReference,
  FieldDefinition,
  InvocationAst,
  InvocationValue,
  RegisteredCallable
} from "./types.js";

export interface CompletionItem {
  label: string;
  insertText: string;
  detail: string;
  kind: "method" | "parameter" | "value" | "reference";
}

export interface LanguageDiagnostic {
  message: string;
  severity: "error" | "warning";
  offset: number;
}

export interface SignatureHelp {
  label: string;
  documentation: string;
  activeParameter: number;
}

function isReference(value: InvocationValue): value is ContextReference {
  return typeof value === "object" && !Array.isArray(value) && "kind" in value;
}

function valueMatches(field: FieldDefinition, value: InvocationValue): boolean {
  if (field.multiple) {
    return Array.isArray(value) && value.every((entry) => valueMatches({ ...field, multiple: false }, entry));
  }
  if (Array.isArray(value)) {
    return false;
  }
  if (field.type === "context") {
    return isReference(value);
  }
  if (field.type === "enum") {
    return typeof value === "string" && (field.values?.includes(value) ?? false);
  }
  return typeof value === field.type;
}

function formatParameter(field: FieldDefinition): string {
  const base = field.type === "enum" ? field.values?.join(" | ") ?? "string" : field.type;
  return `${field.name}${field.required ? "" : "?"}: ${field.multiple ? `${base}[]` : base}`;
}

function methodSignature(method: RegisteredCallable): string {
  return `${method.id}(${method.input.map(formatParameter).join(", ")}) -> ${method.output.kind}`;
}

export class DextLanguageService {
  constructor(private readonly registry: MethodRegistry) {}

  completions(source: string, cursor = source.length): CompletionItem[] {
    const prefix = source.slice(0, cursor);
    if (!prefix.includes("(")) {
      const typed = /[A-Za-z0-9_.]*$/.exec(prefix)?.[0] ?? "";
      return this.registry
        .list()
        .filter((method) => method.id.startsWith(typed))
        .map((method) => ({
          label: method.id,
          insertText: `${method.id}(`,
          detail: `${method.kind} | ${method.description}`,
          kind: "method"
        }));
    }

    const methodId = prefix.slice(0, prefix.indexOf("(")).trim();
    const method = this.registry.get(methodId);
    if (!method) {
      return [];
    }
    const body = prefix.slice(prefix.indexOf("(") + 1);
    const segment = body.slice(body.lastIndexOf(",") + 1);
    const colon = segment.indexOf(":");
    if (colon < 0) {
      const used = new Set(
        [...body.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(
          (match) => match[1]
        )
      );
      const typed = segment.trim();
      return method.input
        .filter((field) => !used.has(field.name) && field.name.startsWith(typed))
        .map((field) => ({
          label: field.name,
          insertText: `${field.name}: `,
          detail: formatParameter(field),
          kind: "parameter"
        }));
    }

    const fieldName = segment.slice(0, colon).trim();
    const field = method.input.find((candidate) => candidate.name === fieldName);
    if (!field) {
      return [];
    }
    if (field.type === "enum") {
      return (field.values ?? []).map((value) => ({
        label: value,
        insertText: `"${value}"`,
        detail: "enum value",
        kind: "value"
      }));
    }
    if (field.type === "context") {
      return [
        ["@selection", "@selection"],
        ["@activeFile", "@activeFile"],
        ["@file", '@file("")'],
        ["@symbol", '@symbol("")']
      ].map(([label, insertText]) => ({
        label: label ?? "",
        insertText: insertText ?? "",
        detail: "context reference",
        kind: "reference" as const
      }));
    }
    if (field.type === "boolean") {
      return ["true", "false"].map((value) => ({
        label: value,
        insertText: value,
        detail: "boolean",
        kind: "value" as const
      }));
    }
    return [];
  }

  diagnostics(source: string): LanguageDiagnostic[] {
    let invocation: InvocationAst;
    try {
      invocation = parseInvocation(source);
    } catch (error) {
      if (error instanceof DslSyntaxError) {
        return [{ message: error.message, severity: "error", offset: error.offset }];
      }
      throw error;
    }

    const method = this.registry.get(invocation.method);
    if (!method) {
      return [{ message: `Unknown method '${invocation.method}'.`, severity: "error", offset: 0 }];
    }
    const diagnostics: LanguageDiagnostic[] = [];
    const seen = new Set<string>();
    for (const argument of invocation.arguments) {
      if (seen.has(argument.name)) {
        diagnostics.push({
          message: `Argument '${argument.name}' is provided more than once.`,
          severity: "error",
          offset: source.indexOf(argument.name)
        });
        continue;
      }
      seen.add(argument.name);
      const field = method.input.find((candidate) => candidate.name === argument.name);
      if (!field) {
        diagnostics.push({
          message: `Unknown argument '${argument.name}'.`,
          severity: "error",
          offset: source.indexOf(argument.name)
        });
      } else if (!valueMatches(field, argument.value)) {
        diagnostics.push({
          message: `Argument '${argument.name}' does not match ${formatParameter(field)}.`,
          severity: "error",
          offset: source.indexOf(argument.name)
        });
      }
    }
    for (const field of method.input) {
      if (field.required && !seen.has(field.name)) {
        diagnostics.push({
          message: `Missing required argument '${field.name}'.`,
          severity: "error",
          offset: source.length
        });
      }
    }
    return diagnostics;
  }

  signature(source: string, cursor = source.length): SignatureHelp | undefined {
    const open = source.indexOf("(");
    if (open < 0 || cursor <= open) {
      return undefined;
    }
    const method = this.registry.get(source.slice(0, open).trim());
    if (!method) {
      return undefined;
    }
    const activeParameter = Math.min(
      (source.slice(open + 1, cursor).match(/,/g) ?? []).length,
      Math.max(0, method.input.length - 1)
    );
    return {
      label: methodSignature(method),
      documentation: method.description,
      activeParameter
    };
  }
}
