import type { MethodRegistry } from "./registry.js";
import type { FieldDefinition, RegisteredCallable } from "./types.js";
import { formatFieldType, formatMethodParameter, formatMethodSignature } from "./methodSignature.js";
import { compileWorkflow, parseWorkflowImports } from "./workflow.js";
import type { SkillDescriptor } from "./skillCatalog.js";

export interface CompletionItem {
  label: string;
  insertText: string;
  detail: string;
  kind: "namespace" | "method" | "parameter" | "value" | "reference";
  /** Stable ordering hint for clients whose completion widget sorts labels. */
  sortText?: string;
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

export interface ApiCompletionContext {
  namespace: string;
  imported: string[];
}

interface OpenCall {
  method: string;
  body: string;
}

interface VisibleMethod {
  name: string;
  method: RegisteredCallable;
}

const CONVERSATION_METHODS = new Set(["agent", "ask", "plan"]);

function inputFields(method: RegisteredCallable): readonly FieldDefinition[] {
  return CONVERSATION_METHODS.has(method.id)
    ? method.input
    : method.input.filter((field) => !field.internal);
}

function signatureOptions(method: RegisteredCallable): { includeInternal: true } | undefined {
  return CONVERSATION_METHODS.has(method.id) ? { includeInternal: true } : undefined;
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
  const method = /[A-Za-z_][A-Za-z0-9_.-]*$/.exec(source.slice(0, open))?.[0];
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
    else if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) start = offset + 1;
  }
  return body.slice(start);
}

function topLevelCommaCount(body: string): number {
  let commas = 0;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of body) {
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) commas += 1;
  }
  return commas;
}

const RESULT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  chat: ["text"],
  agent: ["text", "summary", "patch", "files"],
  explain: ["text", "files"],
  edit: ["summary", "patch", "files"],
  review: ["status", "summary", "findings"],
  apply: ["status", "summary", "files"],
  terminal: ["status", "command", "cwd", "exit_code", "stdout", "stderr", "duration_ms"],
  print: ["text", "label"],
  text: ["text"],
  code: ["code", "language", "title"],
  plan: ["title", "steps"],
  patch: ["title", "changes"],
  ui: ["type", "selected", "custom", "confirmed", "value"]
};

const RESULT_FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  chat: { text: "string" },
  agent: { text: "string", summary: "string | undefined", patch: "PatchResult | undefined", files: "CodeRef[] | undefined" },
  explain: { text: "string", files: "CodeRef[]" },
  edit: { summary: "string", patch: "PatchResult", files: "CodeRef[]" },
  review: { status: '"pass" | "warning" | "fail"', summary: "string", findings: "ReviewFinding[]" },
  apply: { status: '"applied" | "unchanged" | "conflict"', summary: "string", files: "CodeRef[]" },
  terminal: { status: '"succeeded" | "failed" | "timed_out"', command: "string", cwd: "string", exit_code: "number", stdout: "string", stderr: "string", duration_ms: "number" },
  print: { text: "string", label: "string | undefined" },
  text: { text: "string" },
  code: { code: "string", language: "string", title: "string | undefined" },
  plan: { title: "string", steps: "PlanStep[]" },
  patch: { title: "string", changes: "PatchChange[]" },
  ui: { type: '"choice" | "confirm" | "input"', selected: "string[]", custom: "string | undefined", confirmed: "boolean", value: "string | undefined" }
};

function resultTypeName(output: string): string {
  return `${output.slice(0, 1).toUpperCase()}${output.slice(1)}Result`;
}

function outputFields(method: RegisteredCallable | undefined): readonly FieldDefinition[] {
  if (!method) return [];
  if (method.output.fields) return method.output.fields;
  return (RESULT_FIELDS[method.output.kind] ?? []).map((name) => ({ name, type: "string" }));
}

function childFields(field: FieldDefinition | undefined): readonly FieldDefinition[] {
  if (!field) return [];
  // A dot after an array-valued field addresses its element shape. This keeps
  // completion useful for MCP responses such as `result: [{ id, content }]`.
  if (field.type === "list") return childFields(field.items);
  return field.properties ?? [];
}

/** Split a member expression while treating numeric (or computed) indexes as
 * transparent traversal through an array element, e.g. `files[0].content`. */
function expressionParts(expression: string): string[] {
  return expression.match(/[A-Za-z_]\w*|\[[^\]]*\]/g) ?? [];
}

export class DextLanguageService {
  private customApiIds = new Set<string>();
  private skills: SkillDescriptor[] = [];

  constructor(private readonly registry: MethodRegistry) {}

  setCustomApiIds(ids: ReadonlySet<string>): void {
    this.customApiIds = new Set(ids);
  }

  setSkillCompletions(skills: readonly SkillDescriptor[]): void {
    this.skills = [...skills];
  }

  private visibleMethodEntries(source: string, customApisAreGlobal = true): VisibleMethod[] {
    const imports = parseWorkflowImports(source);
    const entries: VisibleMethod[] = [];
    for (const method of this.registry.list()) {
      if (!this.customApiIds.has(method.id)) {
        entries.push({ name: method.id, method });
        continue;
      }
      if (customApisAreGlobal) {
        entries.push({ name: method.id, method });
        continue;
      }
      for (const [alias, imported] of imports) {
        if (method.id === imported) entries.push({ name: alias, method });
        else if (method.id.startsWith(`${imported}.`)) entries.push({ name: `${alias}${method.id.slice(imported.length)}`, method });
      }
    }
    return entries;
  }

  private resolveMethod(source: string, name: string, customApisAreGlobal = true): RegisteredCallable | undefined {
    return this.visibleMethodEntries(source, customApisAreGlobal).find((entry) => entry.name === name)?.method;
  }

  /** Fields exposed by a variable or a dotted expression rooted at a result. */
  private expressionFields(source: string, expression: string, customApisAreGlobal = true): readonly FieldDefinition[] {
    const parts = expression.split(".").flatMap(expressionParts);
    const root = parts.shift();
    if (!root) return [];
    let fields: readonly FieldDefinition[] = [];
    const assignment = new RegExp(`^\\s*${root}\\s*=\\s*([A-Za-z_][A-Za-z0-9_.-]*)\\(`, "m").exec(source);
    if (assignment) {
      fields = outputFields(this.resolveMethod(source, assignment[1] ?? "", customApisAreGlobal));
    } else {
      // Loop variables inherit the element type of the iterable expression.
      const loop = [...source.matchAll(new RegExp(`^\\s*for\\s+${root}\\s+in\\s+([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*)\\s*:`, "gm"))].at(-1);
      if (loop?.[1] && loop[1] !== root) fields = this.expressionFields(source, loop[1], customApisAreGlobal);
    }
    for (const part of parts) {
      if (part.startsWith("[")) continue;
      const field = fields.find((candidate) => candidate.name === part);
      fields = childFields(field);
    }
    return fields;
  }

  apiCompletions(source: string, cursor = source.length, apiId?: string): CompletionItem[] {
    const before = source.slice(0, cursor);
    const word = /[A-Za-z_][A-Za-z0-9_.-]*$/.exec(before)?.[0] ?? "";
    const fragment = word.split(".").at(-1) ?? "";
    const replaceStart = cursor - fragment.length;
    const replaceEnd = cursor;
    const item = (label: string, insertText: string, detail: string, kind: CompletionItem["kind"]): CompletionItem => ({
      label,
      insertText,
      detail,
      kind,
      replaceStart,
      replaceEnd
    });
    if (/\bfrom\s+[A-Za-z_][A-Za-z0-9_.-]*\s+import\s+[A-Za-z_]*$/.test(before)) {
      return this.apiImportItems(before, item);
    }
    if (/\bfrom\s+[A-Za-z_][A-Za-z0-9_.-]*$/.test(before)) {
      return this.apiNamespaceItems(before, item);
    }
    if (/\bimport\s+[A-Za-z_][A-Za-z0-9_.-]*$/.test(before)) {
      return this.apiNamespaceItems(before, item);
    }
    if (/:\s*[A-Za-z_]*$/.test(before)) {
      const types = ["Context", "Result", "list", "Literal", "ChatResult", "AgentResult", "ApplyResult", "TerminalResult", "PrintResult", "McpRawResult", "TextResult", "CodeResult", "PlanResult", "PatchResult"];
      const typeFragment = /[A-Za-z_]*$/.exec(before)?.[0] ?? "";
      return types.filter((type) => type.startsWith(typeFragment)).map((type) => item(type, type, "Dext type", "value"));
    }
    if (/\bmain\([^)]*$/.test(before)) {
      const definition = apiId ? this.registry.get(apiId) : undefined;
      if (definition) {
        return inputFields(definition)
          .map((field, index) => ({
            ...item(field.name, `${field.name}: `, formatMethodParameter(field), "parameter"),
            sortText: String(index).padStart(4, "0")
          }));
      }
    }
    return this.documentCompletions(source, cursor, false);
  }

  private apiNamespaceItems(source: string, item: (label: string, insertText: string, detail: string, kind: CompletionItem["kind"]) => CompletionItem): CompletionItem[] {
    const match = /\b(?:from|import)\s+([A-Za-z_][A-Za-z0-9_.-]*)$/.exec(source);
    const prefix = match?.[1] ?? "";
    const base = prefix.endsWith(".") ? prefix.slice(0, -1) : prefix;
    const partial = prefix.endsWith(".") ? "" : base.split(".").at(-1) ?? "";
    const basePrefix = prefix.endsWith(".") ? `${base}.` : "";
    const labels = new Map<string, number>();
    for (const method of this.registry.list()) {
      if (basePrefix && !method.id.startsWith(basePrefix)) continue;
      if (!basePrefix && partial && !method.id.split(".")[0]!.startsWith(partial)) continue;
      const remaining = basePrefix ? method.id.slice(basePrefix.length) : method.id;
      const segment = remaining.split(".")[0];
      if (segment && (!basePrefix || segment.startsWith(partial))) labels.set(segment, (labels.get(segment) ?? 0) + 1);
    }
    return [...labels].map(([label, count]) => item(label, label, `namespace | ${count} APIs`, "namespace"));
  }

  private apiImportItems(source: string, item: (label: string, insertText: string, detail: string, kind: CompletionItem["kind"]) => CompletionItem): CompletionItem[] {
    const match = /\bfrom\s+([A-Za-z_][A-Za-z0-9_.-]*)\s+import\s+([A-Za-z_]*)$/.exec(source);
    const namespace = match?.[1] ?? "";
    const fragment = match?.[2] ?? "";
    const names = new Map<string, RegisteredCallable>();
    for (const method of this.registry.list()) {
      if (!method.id.startsWith(`${namespace}.`)) continue;
      const rest = method.id.slice(namespace.length + 1);
      if (!rest.includes(".") && rest.startsWith(fragment)) names.set(rest, method);
    }
    return [...names].map(([label, method]) => item(label, label, formatMethodSignature(method, signatureOptions(method)), "method"));
  }

  inputDocument(source: string): WorkflowDocumentState {
    if (!source.trim()) return { kind: "empty" };
    return {
      kind: compileWorkflow(source, this.registry, {
        allowImports: true,
        aliases: parseWorkflowImports(source),
        customApiIds: this.customApiIds,
        requireCustomApiImports: false
      }).program ? "workflow" : "invalid"
    };
  }

  documentCompletions(source: string, cursor = source.length, customApisAreGlobal = true): CompletionItem[] {
    const before = source.slice(0, cursor);
    const word = /[A-Za-z_][A-Za-z0-9_.-]*$/.exec(before)?.[0] ?? "";
    const fragmentStart = word.lastIndexOf(".") + 1;
    const replaceStart = cursor - (word.length - fragmentStart);
    const replaceEnd = cursor + (/^[A-Za-z0-9_]*/.exec(source.slice(cursor))?.[0].length ?? 0);
    const item = (
      label: string,
      insertText: string,
      detail: string,
      kind: CompletionItem["kind"]
    ): CompletionItem => ({ label, insertText, detail, kind, replaceStart, replaceEnd });

    const statusComparison = /([A-Za-z_][A-Za-z0-9_]*)\.status\s*(?:==|!=)\s*(?:["']([^"']*)$|([A-Za-z_][A-Za-z0-9_]*)$|)$/.exec(before);
    if (statusComparison) {
      const assignment = new RegExp(
        `^\\s*${statusComparison[1]}\\s*=\\s*([A-Za-z_][A-Za-z0-9_.-]*)\\(`,
        "m"
      ).exec(source);
      const output = assignment ? this.resolveMethod(source, assignment[1] ?? "", customApisAreGlobal)?.output.kind : undefined;
      if (output === "review" || output === "apply" || output === "terminal") {
        const values = output === "review"
          ? ["pass", "warning", "fail"]
          : output === "apply"
            ? ["applied", "unchanged", "conflict"]
            : ["succeeded", "failed", "timed_out"];
        const fragment = statusComparison[2] ?? statusComparison[3] ?? "";
        const hasQuote = /["']$/.test(before);
        const valueStart = hasQuote ? cursor - fragment.length - 1 : cursor - fragment.length;
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

    const member = /([A-Za-z_]\w*(?:(?:\.[A-Za-z_]\w*)|(?:\[\s*[^\]]+\s*\]))*)\.([A-Za-z_]*)$/.exec(before);
    if (member) {
      const fields = this.expressionFields(source, member[1] ?? "", customApisAreGlobal);
      const root = (member[1] ?? "").split(".")[0] ?? "";
      const method = this.resolveMethod(
        source,
        new RegExp(`^\\s*${root}\\s*=\\s*([A-Za-z_][A-Za-z0-9_.-]*)\\(`, "m").exec(source)?.[1] ?? "",
        customApisAreGlobal
      );
      if (fields.length) {
        return fields
          .filter((field) => field.name.startsWith(member[2] ?? ""))
          .map((field) => item(field.name, field.name, `${method?.output.resultType ?? resultTypeName(method?.output.kind ?? "result")} field`, "parameter"));
      }
    }

    const call = openCall(source, cursor);
    if (call) {
      const method = this.resolveMethod(source, call.method, customApisAreGlobal);
      if (method) {
        const segment = activeArgument(call.body);
        const assignment = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=([\s\S]*)$/.exec(segment);
        if (assignment) {
          const field = method.input.find((candidate) => candidate.name === assignment[1]);
          const value = assignment[2]?.trimStart() ?? "";
          const valueStart = cursor - value.length;
          if (field?.type === "context") {
            const fragment = /(?:^|\[\s*|,\s*)(@?[A-Za-z_.]*)$/.exec(value)?.[1] ?? "";
            const references = [
              ["@selection", "@selection", "active editor selection"],
              ["@active_file", "@active_file", "complete active editor file"]
            ] as const;
            const referenceItems = references.filter(([label]) => label.startsWith(fragment)).map(([label, insertText, detail]) => ({
              label,
              insertText,
              detail,
              kind: "reference" as const,
              replaceStart: cursor - fragment.length,
              replaceEnd: cursor
            }));
            if (!field.accepts?.includes("result")) return referenceItems;
            const resultVariables = [...source.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_][A-Za-z0-9_.-]*)\(/gm)]
            .map((match) => ({ name: match[1]!, output: this.resolveMethod(source, match[2]!, customApisAreGlobal)?.output.kind }))
              .filter((entry) => entry.output !== undefined)
              .map((entry) => ({ name: entry.name, output: entry.output! }));
            return [
              ...referenceItems,
              ...resultVariables.filter(({ name }) => name.startsWith(fragment)).map(({ name, output }) => ({
                label: name,
                insertText: name,
                detail: `${resultTypeName(output)} result`,
                kind: "value" as const,
                replaceStart: cursor - fragment.length,
                replaceEnd: cursor
              }))
            ];
          }
          if (field?.type === "result" || field?.accepts?.includes("result")) {
            const fragment = /(?:^|(?:\[|,)\s*)([A-Za-z_]\w*)$/.exec(value)?.[1] ?? "";
            const variables = [...source.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_][A-Za-z0-9_.-]*)\(/gm)]
              .map((match) => ({ name: match[1]!, output: this.resolveMethod(source, match[2]!, customApisAreGlobal)?.output.kind }))
              .filter((entry) => entry.output !== undefined)
              .map((entry) => ({ name: entry.name, output: entry.output! }));
            return variables.filter(({ name }) => name.startsWith(fragment)).map(({ name, output }) => ({
              label: name,
              insertText: name,
              detail: `${resultTypeName(output)} result`,
              kind: "value" as const,
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
          if (call.method === "skill" && assignment[1] === "skill") {
            const fragment = value.startsWith('"') || value.startsWith("'") ? value.slice(1) : value;
            return this.skills.filter((skill) => skill.id.startsWith(fragment)).map((skill) => ({
              label: skill.id,
              insertText: `"${skill.id}"`,
              detail: `${skill.title} - ${skill.description}`,
              kind: "value" as const,
              replaceStart: valueStart,
              replaceEnd: cursor
            }));
          }
          return [];
        }
        const used = new Set(
          [...call.body.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=/g)].map((match) => match[1])
        );
        const fragment = /[A-Za-z_][A-Za-z0-9_]*$/.exec(segment)?.[0] ?? "";
        const parameters = inputFields(method);
        // Prefer the first unused parameter at the current positional slot.
        // This makes the common `foo(first=..., ` flow surface the next field
        // immediately, while keeping declaration order for the rest.
        const argumentIndex = parameters.length
          ? Math.min(topLevelCommaCount(call.body), parameters.length - 1)
          : 0;
        const expected = parameters.slice(argumentIndex).find((field) => !used.has(field.name))
          ?? parameters.find((field) => !used.has(field.name));
        const candidates = parameters
          .filter((field) => !used.has(field.name) && field.name.startsWith(fragment));
        const expectedIndex = candidates.findIndex((field) => field.name === expected?.name);
        const ordered = expectedIndex > 0
          ? [candidates[expectedIndex]!, ...candidates.slice(0, expectedIndex), ...candidates.slice(expectedIndex + 1)]
          : candidates;
        return ordered.map((field, index) => ({
          ...item(field.name, `${field.name}=`, formatMethodParameter(field), "parameter"),
          sortText: String(index).padStart(4, "0")
        }));
      }
    }

    if (!word) return [];
    const methods = this.visibleMethodEntries(source, customApisAreGlobal);
    const path = word.split(".");
    const fragment = path.pop() ?? "";
    const prefix = path.length ? `${path.join(".")}.` : "";
    const namespaces = new Map<string, number>();
    const completions: CompletionItem[] = [];
    for (const entry of methods) {
      if (!entry.name.startsWith(prefix)) continue;
      const remaining = entry.name.slice(prefix.length);
      const [segment, ...tail] = remaining.split(".");
      if (!segment?.startsWith(fragment)) continue;
      if (tail.length) namespaces.set(segment, (namespaces.get(segment) ?? 0) + 1);
      else completions.push(item(segment, `${segment}(`, `${entry.method.kind} | ${entry.method.output.kind}`, "method"));
    }
    for (const [label, count] of namespaces) {
      completions.push(item(label, `${label}.`, `namespace | ${count} methods`, "namespace"));
    }
    return completions.sort((left, right) => left.label.localeCompare(right.label));
  }

  documentDiagnostics(source: string): LanguageDiagnostic[] {
    if (!source.trim()) return [];
    return compileWorkflow(source, this.registry, {
      allowImports: true,
      aliases: parseWorkflowImports(source),
      customApiIds: this.customApiIds,
      requireCustomApiImports: false
    }).diagnostics.map((diagnostic) => ({
      message: diagnostic.message,
      severity: diagnostic.severity,
      offset: diagnostic.from,
      from: diagnostic.from,
      to: diagnostic.to
    }));
  }

  apiHover(source: string, cursor: number): LanguageHover | undefined {
    return this.documentHover(source, cursor, false);
  }

  documentHover(source: string, cursor: number, customApisAreGlobal = true): LanguageHover | undefined {
    const pattern = /[A-Za-z_][A-Za-z0-9_.-]*/g;
    for (const match of source.matchAll(pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (cursor < from || cursor > to) continue;
      const method = this.resolveMethod(source, match[0], customApisAreGlobal);
      if (method) {
        return {
          rangeStart: from,
          rangeEnd: to,
          label: formatMethodSignature(method, signatureOptions(method)),
          documentation: method.description
        };
      }
      const member = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(match[0]);
      if (member) {
        const assignment = new RegExp(`^\\s*${member[1]}\\s*=\\s*([A-Za-z_][A-Za-z0-9_.-]*)\\(`, "m").exec(source);
        const outputMethod = assignment ? this.resolveMethod(source, assignment[1] ?? "", customApisAreGlobal) : undefined;
        const field = outputFields(outputMethod).find((candidate) => candidate.name === member[2]);
        const type = outputMethod?.output.fields
          ? field ? formatFieldType(field) : undefined
          : outputMethod ? RESULT_FIELD_TYPES[outputMethod.output.kind]?.[member[2] ?? ""] : undefined;
        if (outputMethod && type) {
          return {
            rangeStart: from,
            rangeEnd: to,
            label: `${member[0]}: ${type}`,
            documentation: `${outputMethod.output.resultType ?? resultTypeName(outputMethod.output.kind)} field returned by ${assignment?.[1] ?? outputMethod.output.kind}.`
          };
        }
      }
      const variableAssignment = new RegExp(`^\\s*${match[0]}\\s*=\\s*([A-Za-z_][A-Za-z0-9_.-]*)\\(`, "m").exec(source);
      if (variableAssignment) {
        const output = this.resolveMethod(source, variableAssignment[1] ?? "", customApisAreGlobal)?.output.kind;
        if (output) {
          return {
            rangeStart: from,
            rangeEnd: to,
            label: `${match[0]}: ${resultTypeName(output)}`,
            documentation: `Result returned by ${variableAssignment[1]}.`
          };
        }
      }
    }
    return undefined;
  }

  apiSignature(source: string, cursor = source.length): SignatureHelp | undefined {
    return this.documentSignature(source, cursor, false);
  }

  documentSignature(source: string, cursor = source.length, customApisAreGlobal = true): SignatureHelp | undefined {
    const call = /([A-Za-z_][A-Za-z0-9_.-]*)\(([^()]*)$/.exec(source.slice(0, cursor));
    const method = call ? this.resolveMethod(source, call[1] ?? "", customApisAreGlobal) : undefined;
    if (!call || !method) return undefined;
    const parameters = inputFields(method);
    const body = call[2] ?? "";
    const segment = activeArgument(body);
    const named = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=/.exec(segment)?.[1];
    const positionalIndex = Math.min(
      topLevelCommaCount(body),
      Math.max(0, parameters.length - 1)
    );
    const namedIndex = named ? parameters.findIndex((field) => field.name === named) : -1;
    const activeParameter = namedIndex >= 0 ? namedIndex : positionalIndex;
    return {
      label: formatMethodSignature(method, signatureOptions(method)),
      documentation: method.description,
      activeParameter,
      parameters: parameters.map((field) => ({
        label: formatMethodParameter(field),
        documentation: field.description ?? ""
      }))
    };
  }
}
