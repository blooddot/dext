import type { MethodRegistry } from "./registry.js";
import type { FieldDefinition, RegisteredCallable } from "./types.js";
import { compileWorkflow } from "./workflow.js";

export interface CompletionItem {
  label: string;
  insertText: string;
  detail: string;
  kind: "namespace" | "method" | "parameter" | "value" | "reference";
  replaceStart: number;
  replaceEnd: number;
}

export interface LanguageDiagnostic {
  message: string;
  severity: "error" | "warning";
  offset: number;
  from?: number;
  to?: number;
}

export interface SignatureHelp {
  label: string;
  documentation: string;
  activeParameter: number;
  parameters: { label: string; documentation: string }[];
}

export interface LanguageHover {
  rangeStart: number;
  rangeEnd: number;
  label: string;
  documentation: string;
}

export interface WorkflowDocumentState {
  kind: "empty" | "workflow" | "invalid";
}

function formatParameter(field: FieldDefinition): string {
  const base = field.type === "enum" ? field.values?.join(" | ") ?? "string" : field.type;
  return `${field.name}${field.required ? "" : "?"}=${field.multiple ? `${base} | ${base}[]` : base}`;
}

function methodSignature(method: RegisteredCallable): string {
  return `${method.id}(${method.input.map(formatParameter).join(", ")}) -> ${method.output.kind}`;
}

interface OpenCall {
  method: string;
  body: string;
}

function openCall(source: string, cursor: number): OpenCall | undefined {
  const stack: number[] = [];
  let quote: "'" | '"' | undefined;
  let triple = false;
  let escaped = false;
  for (let offset = 0; offset < cursor; offset += 1) {
    const character = source[offset];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (triple && source.slice(offset, offset + 3) === quote.repeat(3)) {
        quote = undefined;
        triple = false;
        offset += 2;
      } else if (!triple && character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      triple = source.slice(offset, offset + 3) === character.repeat(3);
      if (triple) offset += 2;
    } else if (character === "(") stack.push(offset);
    else if (character === ")") stack.pop();
  }
  const open = stack.at(-1);
  if (open === undefined) return undefined;
  const method = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(source.slice(0, open))?.[0];
  return method ? { method, body: source.slice(open + 1, cursor) } : undefined;
}

function activeArgument(body: string): string {
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let offset = 0; offset < body.length; offset += 1) {
    const character = body[offset];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) start = offset + 1;
  }
  return body.slice(start);
}

const RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  chat: ["text"],
  explain: ["text", "files"],
  edit: ["summary", "patch", "files"],
  review: ["status", "summary", "findings"],
  apply: ["status", "summary", "files"],
  terminal: ["status", "command", "cwd", "exit_code", "stdout", "stderr", "duration_ms"],
  print: ["text", "label"]
};

export class DextLanguageService {
  constructor(private readonly registry: MethodRegistry) {}

  inputDocument(source: string): WorkflowDocumentState {
    if (!source.trim()) return { kind: "empty" };
    return { kind: compileWorkflow(source, this.registry).program ? "workflow" : "invalid" };
  }

  documentCompletions(source: string, cursor = source.length): CompletionItem[] {
    const before = source.slice(0, cursor);
    const word = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(before)?.[0] ?? "";
    const fragmentStart = word.lastIndexOf(".") + 1;
    const replaceStart = cursor - (word.length - fragmentStart);
    const replaceEnd = cursor + (/^[A-Za-z0-9_]*/.exec(source.slice(cursor))?.[0].length ?? 0);
    const item = (
      label: string,
      insertText: string,
      detail: string,
      kind: CompletionItem["kind"]
    ): CompletionItem => ({ label, insertText, detail, kind, replaceStart, replaceEnd });

    if (/ref\.[A-Za-z_]*$/.test(before)) {
      const fragment = word.split(".").at(-1) ?? "";
      const references: [string, string][] = [
        ["selection", "selection"],
        ["active_file", "active_file"],
        ["file", 'file("")'],
        ["symbol", 'symbol("")']
      ];
      return references.filter(([label]) => label.startsWith(fragment))
        .map(([label, insert]) => item(label, insert, "context reference", "reference"));
    }

    const statusComparison = /([A-Za-z_][A-Za-z0-9_]*)\.status\s*(?:==|!=)\s*["']([^"']*)$/.exec(before);
    if (statusComparison) {
      const assignment = new RegExp(
        `^\\s*${statusComparison[1]}\\s*=\\s*([A-Za-z_][A-Za-z0-9_.]*)\\(`,
        "m"
      ).exec(source);
      const output = assignment ? this.registry.get(assignment[1] ?? "")?.output.kind : undefined;
      if (output === "review" || output === "apply" || output === "terminal") {
        const values = output === "review"
          ? ["pass", "warning", "fail"]
          : output === "apply"
            ? ["applied", "unchanged", "conflict"]
            : ["succeeded", "failed", "timed_out"];
        const fragment = statusComparison[2] ?? "";
        const valueStart = cursor - fragment.length - 1;
        return values.filter((value) => value.startsWith(fragment)).map((value) => ({
          label: value,
          insertText: `"${value}"`,
          detail: `${output} status`,
          kind: "value",
          replaceStart: valueStart,
          replaceEnd: cursor
        }));
      }
    }

    const member = /([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_]*)$/.exec(before);
    if (member) {
      const assignment = new RegExp(
        `^\\s*${member[1]}\\s*=\\s*([A-Za-z_][A-Za-z0-9_.]*)\\(`,
        "m"
      ).exec(source);
      const output = assignment ? this.registry.get(assignment[1] ?? "")?.output.kind : undefined;
      if (output) {
        return (RESULT_FIELDS[output] ?? [])
          .filter((field) => field.startsWith(member[2] ?? ""))
          .map((field) => item(field, field, `${output} result field`, "parameter"));
      }
    }

    const call = openCall(source, cursor);
    if (call) {
      const method = this.registry.get(call.method);
      if (method) {
        const segment = activeArgument(call.body);
        const assignment = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]*)$/.exec(segment);
        if (assignment) {
          const field = method.input.find((candidate) => candidate.name === assignment[1]);
          const value = assignment[2]?.trimStart() ?? "";
          const valueStart = cursor - value.length;
          if (field?.type === "context") {
            const fragment = /(?:^|\[\s*|,\s*)([A-Za-z_.]*)$/.exec(value)?.[1] ?? "";
            const references = [
              ["ref.selection", "ref.selection"],
              ["ref.active_file", "ref.active_file"],
              ["ref.file", 'ref.file("")'],
              ["ref.symbol", 'ref.symbol("")']
            ] as const;
            return references.filter(([label]) => label.startsWith(fragment)).map(([label, insertText]) => ({
              label,
              insertText,
              detail: "context reference",
              kind: "reference",
              replaceStart: cursor - fragment.length,
              replaceEnd: cursor
            }));
          }
          if (field?.type === "boolean") {
            return ["True", "False"].filter((option) => option.startsWith(value)).map((option) => ({
              label: option,
              insertText: option,
              detail: "boolean",
              kind: "value",
              replaceStart: valueStart,
              replaceEnd: cursor
            }));
          }
          if (field?.type === "enum") {
            const fragment = value.startsWith('"') || value.startsWith("'") ? value.slice(1) : value;
            return (field.values ?? []).filter((option) => option.startsWith(fragment)).map((option) => ({
              label: option,
              insertText: `"${option}"`,
              detail: "enum value",
              kind: "value",
              replaceStart: valueStart,
              replaceEnd: cursor
            }));
          }
          return [];
        }
        const used = new Set(
          [...call.body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((match) => match[1])
        );
        const fragment = /[A-Za-z_][A-Za-z0-9_]*$/.exec(segment)?.[0] ?? "";
        return method.input
          .filter((field) => !used.has(field.name) && field.name.startsWith(fragment))
          .map((field) => item(field.name, `${field.name}=`, formatParameter(field), "parameter"));
      }
    }

    const methods = this.registry.list();
    const path = word.split(".");
    const fragment = path.pop() ?? "";
    const prefix = path.length ? `${path.join(".")}.` : "";
    const namespaces = new Map<string, number>();
    const completions: CompletionItem[] = [];
    for (const method of methods) {
      if (!method.id.startsWith(prefix)) continue;
      const remaining = method.id.slice(prefix.length);
      const [segment, ...tail] = remaining.split(".");
      if (!segment?.startsWith(fragment)) continue;
      if (tail.length) namespaces.set(segment, (namespaces.get(segment) ?? 0) + 1);
      else completions.push(item(segment, `${segment}(`, `${method.kind} | ${method.output.kind}`, "method"));
    }
    for (const [label, count] of namespaces) {
      completions.push(item(label, `${label}.`, `namespace | ${count} methods`, "namespace"));
    }
    return completions.sort((left, right) => left.label.localeCompare(right.label));
  }

  documentDiagnostics(source: string): LanguageDiagnostic[] {
    if (!source.trim()) return [];
    return compileWorkflow(source, this.registry).diagnostics.map((diagnostic) => ({
      message: diagnostic.message,
      severity: diagnostic.severity,
      offset: diagnostic.from,
      from: diagnostic.from,
      to: diagnostic.to
    }));
  }

  documentHover(source: string, cursor: number): LanguageHover | undefined {
    const pattern = /[A-Za-z_][A-Za-z0-9_.]*/g;
    for (const match of source.matchAll(pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (cursor < from || cursor > to) continue;
      const method = this.registry.get(match[0]);
      if (method) {
        return {
          rangeStart: from,
          rangeEnd: to,
          label: methodSignature(method),
          documentation: method.description
        };
      }
      const docs: Record<string, string> = {
        "ref.selection": "Current editor selection.",
        "ref.active_file": "Current active file.",
        "ref.file": "Immutable workspace file or range reference.",
        "ref.symbol": "Workspace symbol reference."
      };
      const documentation = docs[match[0]];
      if (documentation) {
        return { rangeStart: from, rangeEnd: to, label: match[0], documentation };
      }
    }
    return undefined;
  }

  documentSignature(source: string, cursor = source.length): SignatureHelp | undefined {
    const call = /([A-Za-z_][A-Za-z0-9_.]*)\(([^()]*)$/.exec(source.slice(0, cursor));
    const method = call ? this.registry.get(call[1] ?? "") : undefined;
    if (!call || !method) return undefined;
    const activeParameter = Math.min(
      call[2]?.match(/,/g)?.length ?? 0,
      Math.max(0, method.input.length - 1)
    );
    return {
      label: methodSignature(method),
      documentation: method.description,
      activeParameter,
      parameters: method.input.map((field) => ({
        label: formatParameter(field),
        documentation: field.description ?? ""
      }))
    };
  }
}
