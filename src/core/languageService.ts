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
  kind: "namespace" | "method" | "parameter" | "value" | "reference";
  replaceStart: number;
  replaceEnd: number;
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
  parameters: { label: string; documentation: string }[];
}

export interface LanguageHover {
  rangeStart: number;
  rangeEnd: number;
  label: string;
  documentation: string;
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

function unclosedCallOffset(source: string): number | undefined {
  let callOffset: number | undefined;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let offset = 0; offset < source.length; offset += 1) {
    const character = source[offset];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      if (depth === 0) callOffset = offset;
      depth += 1;
    } else if (character === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0) callOffset = undefined;
    }
  }

  return depth > 0 ? callOffset : undefined;
}

function topLevelOffsets(source: string, target: "," | ":"): number[] {
  const offsets: number[] = [];
  let parentheses = 0;
  let brackets = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let offset = 0; offset < source.length; offset += 1) {
    const character = source[offset];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") parentheses += 1;
    else if (character === ")" && parentheses > 0) parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]" && brackets > 0) brackets -= 1;
    else if (character === target && parentheses === 0 && brackets === 0) offsets.push(offset);
  }
  return offsets;
}

function wordEnd(source: string, cursor: number, pattern: RegExp): number {
  const suffix = pattern.exec(source.slice(cursor))?.[0] ?? "";
  return cursor + suffix.length;
}

function methodPathCompletions(
  methods: RegisteredCallable[],
  typedPath: string,
  replaceStart: number,
  replaceEnd: number
): CompletionItem[] {
  const path = typedPath.split(".");
  const fragment = path.pop() ?? "";
  const namespaces = new Map<string, number>();
  const completions: CompletionItem[] = [];

  for (const method of methods) {
    const segments = method.id.split(".");
    if (
      segments.length <= path.length ||
      path.some((segment, index) => segments[index] !== segment)
    ) {
      continue;
    }
    const label = segments[path.length];
    if (!label?.startsWith(fragment)) {
      continue;
    }
    if (segments.length > path.length + 1) {
      namespaces.set(label, (namespaces.get(label) ?? 0) + 1);
    } else {
      completions.push({
        label,
        insertText: `${label}(`,
        detail: `${method.kind} method | ${method.description}`,
        kind: "method",
        replaceStart,
        replaceEnd
      });
    }
  }

  for (const [label, count] of namespaces) {
    completions.push({
      label,
      insertText: `${label}.`,
      detail: `namespace | ${count} ${count === 1 ? "method" : "methods"}`,
      kind: "namespace",
      replaceStart,
      replaceEnd
    });
  }

  return completions.sort(
    (left, right) => left.label.localeCompare(right.label) || left.kind.localeCompare(right.kind)
  );
}

export class DextLanguageService {
  constructor(private readonly registry: MethodRegistry) {}

  completions(source: string, cursor = source.length): CompletionItem[] {
    const prefix = source.slice(0, cursor);
    if (!prefix.includes("(")) {
      const typed = /[A-Za-z0-9_.]*$/.exec(prefix)?.[0] ?? "";
      const fragment = typed.slice(typed.lastIndexOf(".") + 1);
      return methodPathCompletions(
        this.registry.list(),
        typed,
        cursor - fragment.length,
        wordEnd(source, cursor, /^[A-Za-z0-9_]*/)
      );
    }

    const callOffset = unclosedCallOffset(prefix);
    if (callOffset === undefined) {
      return [];
    }
    const methodId = prefix.slice(0, callOffset).trim();
    const method = this.registry.get(methodId);
    if (!method) {
      return [];
    }
    const body = prefix.slice(callOffset + 1);
    const commaOffsets = topLevelOffsets(body, ",");
    const segmentOffset = (commaOffsets.at(-1) ?? -1) + 1;
    const segment = body.slice(segmentOffset);
    const colon = topLevelOffsets(segment, ":")[0] ?? -1;
    if (colon < 0) {
      const used = new Set(
        [0, ...commaOffsets.map((offset) => offset + 1)]
          .map((offset) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(body.slice(offset))?.[1])
          .filter((name): name is string => name !== undefined)
      );
      const typed = segment.trim();
      const replaceStart = cursor - typed.length;
      const replaceEnd = wordEnd(source, cursor, /^[A-Za-z0-9_]*/);
      return method.input
        .filter((field) => !used.has(field.name) && field.name.startsWith(typed))
        .map((field) => ({
          label: field.name,
          insertText: `${field.name}: `,
          detail: formatParameter(field),
          kind: "parameter",
          replaceStart,
          replaceEnd
        }));
    }

    const fieldName = segment.slice(0, colon).trim();
    const field = method.input.find((candidate) => candidate.name === fieldName);
    if (!field) {
      return [];
    }
    const valueText = segment.slice(colon + 1);
    const leadingWhitespace = /^\s*/.exec(valueText)?.[0].length ?? 0;
    const value = valueText.slice(leadingWhitespace);
    const trimmed = value.trim();
    if (value !== value.trimEnd() && trimmed) {
      return [];
    }
    const valueStart = callOffset + 1 + segmentOffset + colon + 1 + leadingWhitespace;
    const replaceEnd = wordEnd(source, cursor, /^[A-Za-z0-9_]*/);

    if (field.type === "enum") {
      if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed) || (trimmed.startsWith('"') && trimmed.slice(1).includes('"'))) {
        return [];
      }
      const fragment = trimmed.startsWith('"') ? trimmed.slice(1) : trimmed;
      if (!/^[A-Za-z0-9_]*$/.test(fragment)) {
        return [];
      }
      return (field.values ?? []).filter((option) => option.startsWith(fragment)).map((option) => ({
        label: option,
        insertText: `"${option}"`,
        detail: "enum value",
        kind: "value",
        replaceStart: valueStart,
        replaceEnd
      }));
    }
    if (field.type === "context") {
      if (/^@(file|symbol)\s*\(/.test(trimmed)) {
        return [];
      }
      const references = [
        { label: "@selection", insertText: "@selection", terminal: true },
        { label: "@activeFile", insertText: "@activeFile", terminal: true },
        { label: "@file", insertText: '@file("")', terminal: false },
        { label: "@symbol", insertText: '@symbol("")', terminal: false }
      ];
      if (references.some((reference) => reference.terminal && reference.label === trimmed)) {
        return [];
      }
      if (trimmed && !/^@[A-Za-z]*$/.test(trimmed)) {
        return [];
      }
      return references
        .filter((reference) => reference.label.startsWith(trimmed))
        .map((reference) => ({
          label: reference.label,
          insertText: reference.insertText,
          detail: "context reference",
          kind: "reference" as const,
          replaceStart: valueStart,
          replaceEnd
        }));
    }
    if (field.type === "boolean") {
      if (trimmed === "true" || trimmed === "false" || !/^[A-Za-z]*$/.test(trimmed)) {
        return [];
      }
      return ["true", "false"].filter((option) => option.startsWith(trimmed)).map((option) => ({
        label: option,
        insertText: option,
        detail: "boolean",
        kind: "value" as const,
        replaceStart: valueStart,
        replaceEnd
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

  hover(source: string, cursor: number): LanguageHover | undefined {
    let wordStart = cursor;
    let wordEndOffset = cursor;
    while (wordStart > 0 && /[A-Za-z0-9_.]/.test(source[wordStart - 1] ?? "")) wordStart -= 1;
    while (wordEndOffset < source.length && /[A-Za-z0-9_.]/.test(source[wordEndOffset] ?? "")) {
      wordEndOffset += 1;
    }
    const word = source.slice(wordStart, wordEndOffset);
    const method = this.registry.get(word);
    if (method) {
      return {
        rangeStart: wordStart,
        rangeEnd: wordEndOffset,
        label: methodSignature(method),
        documentation: method.description
      };
    }

    const open = source.indexOf("(");
    const invocationMethod = open >= 0 ? this.registry.get(source.slice(0, open).trim()) : undefined;
    if (!invocationMethod || cursor <= open) {
      return undefined;
    }
    const parameterWord = /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) ? word : "";
    const field = invocationMethod.input.find((candidate) => candidate.name === parameterWord);
    if (!field || source.slice(wordEndOffset).match(/^\s*:/) === null) {
      return undefined;
    }
    const qualifiers = [field.required ? "Required." : "Optional."];
    if (field.default !== undefined) qualifiers.push(`Default: ${String(field.default)}.`);
    return {
      rangeStart: wordStart,
      rangeEnd: wordEndOffset,
      label: formatParameter(field),
      documentation: [field.description, ...qualifiers].filter(Boolean).join(" ")
    };
  }

  signature(source: string, cursor = source.length): SignatureHelp | undefined {
    const prefix = source.slice(0, cursor);
    const open = unclosedCallOffset(prefix);
    if (open === undefined || cursor <= open) {
      return undefined;
    }
    const method = this.registry.get(prefix.slice(0, open).trim());
    if (!method) {
      return undefined;
    }
    const activeParameter = Math.min(
      topLevelOffsets(prefix.slice(open + 1), ",").length,
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
