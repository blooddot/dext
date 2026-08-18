import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import type { MethodRegistry } from "./registry.js";
import { normalizeInputReferenceSource } from "./fileReference.js";
import type {
  CallableDefinition,
  ContextReference,
  DirectoryReference,
  FieldDefinition,
  WorkflowCall,
  WorkflowCondition,
  WorkflowExpression,
  WorkflowProgram,
  WorkflowStatement
} from "./types.js";

export interface WorkflowDiagnostic {
  message: string;
  severity: "error" | "warning";
  from: number;
  to: number;
}

export interface WorkflowCompileResult {
  program?: WorkflowProgram;
  diagnostics: WorkflowDiagnostic[];
  returnType?: WorkflowValueType;
}

type ValueType =
  | { kind: "string"; literals?: readonly string[] }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "context" }
  | { kind: "dir" }
  | { kind: "object" }
  | { kind: "list"; item: ValueType }
  | { kind: "result"; name: string; fields: Readonly<Record<string, ValueType>> }
  | { kind: "unknown" };

export type WorkflowValueType = ValueType;

export interface WorkflowCompileOptions {
  allowReturn?: boolean;
  allowNestedCalls?: boolean;
  allowImports?: boolean;
  aliases?: ReadonlyMap<string, string>;
  initialVariables?: ReadonlyMap<string, WorkflowValueType>;
  customApiIds?: ReadonlySet<string>;
  requireCustomApiImports?: boolean;
}

interface EnvironmentEntry {
  type: ValueType;
  from: number;
}

const RESULT_TYPES: Readonly<Record<string, ValueType>> = {
  chat: result("ChatResult", { text: { kind: "string" } }),
  agent: result("AgentResult", {
    text: { kind: "string" },
    summary: { kind: "string" },
    patch: result("PatchResult", {
      title: { kind: "string" },
      changes: { kind: "list", item: { kind: "unknown" } }
    }),
    files: { kind: "list", item: { kind: "context" } }
  }),
  apply: result("ApplyResult", {
    status: { kind: "string", literals: ["applied", "unchanged", "conflict"] },
    summary: { kind: "string" },
    files: { kind: "list", item: { kind: "context" } }
  }),
  terminal: result("TerminalResult", {
    status: { kind: "string", literals: ["succeeded", "failed", "timed_out"] },
    command: { kind: "string" },
    cwd: { kind: "string" },
    exit_code: { kind: "number" },
    stdout: { kind: "string" },
    stderr: { kind: "string" },
    duration_ms: { kind: "number" }
  }),
  print: result("PrintResult", {
    text: { kind: "string" },
    label: { kind: "string" }
  }),
  text: result("TextResult", { text: { kind: "string" } }),
  code: result("CodeResult", { code: { kind: "string" }, language: { kind: "string" } }),
  plan: result("PlanResult", {}),
  patch: result("PatchResult", {
    title: { kind: "string" },
    changes: { kind: "list", item: { kind: "unknown" } }
  }),
  ui: result("UiResult", {
    type: { kind: "string", literals: ["choice", "confirm", "input"] },
    selected: { kind: "list", item: { kind: "string" } },
    custom: { kind: "string" },
    confirmed: { kind: "boolean" },
    value: { kind: "string" }
  }),
  mcpRaw: result("McpRawResult", {
    server: { kind: "string" },
    tool: { kind: "string" },
    content: { kind: "string" },
    structured: { kind: "unknown" }
  })
};

function result(name: string, fields: Readonly<Record<string, ValueType>>): ValueType {
  return { kind: "result", name, fields };
}

function children(node: SyntaxNode): SyntaxNode[] {
  const values: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) values.push(child);
  return values;
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return children(node).filter((child) => !["(", ")", "[", "]", ",", ":", "."].includes(child.name));
}

function text(source: string, node: SyntaxNode): string {
  return source.slice(node.from, node.to);
}

function decodeString(value: string): string {
  const quote = value.startsWith('"""') || value.startsWith("'''") ? value.slice(0, 3) : value.slice(0, 1);
  const body = value.slice(quote.length, -quote.length);
  return body.replace(/\\([\\'"nrt])/g, (_match, escaped: string) => ({
    "\\": "\\",
    "'": "'",
    '"': '"',
    n: "\n",
    r: "\r",
    t: "\t"
  })[escaped] ?? escaped);
}

function memberPath(source: string, node: SyntaxNode): string | undefined {
  if (node.name === "VariableName" || node.name === "PropertyName") return text(source, node);
  if (node.name !== "MemberExpression") return undefined;
  return namedChildren(node).map((child) => text(source, child)).join(".");
}

function resolveAlias(path: string, aliases?: ReadonlyMap<string, string>): string {
  const direct = aliases?.get(path);
  if (direct) return direct;
  const parts = path.split(".");
  const head = aliases?.get(parts[0] ?? "");
  return head ? [head, ...parts.slice(1)].join(".") : path;
}

class Compiler {
  private readonly diagnostics: WorkflowDiagnostic[] = [];
  private readonly environment = new Map<string, EnvironmentEntry>();

  constructor(
    private readonly source: string,
    private readonly registry: MethodRegistry,
    private readonly options: WorkflowCompileOptions = {}
  ) {
    if (options.initialVariables) {
      for (const [name, type] of options.initialVariables) {
        this.environment.set(name, { type, from: 0 });
      }
    }
  }

  compile(): WorkflowCompileResult {
    if (!this.source.trim()) {
      this.error("Enter a Dext workflow.", 0, 0);
      return { diagnostics: this.diagnostics };
    }
    const tree = parser.parse(this.source);
    this.collectSyntaxErrors(tree.topNode);
    const statements = this.compileStatements(tree.topNode);
    if (this.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { diagnostics: this.diagnostics };
    }
    return {
      program: { kind: "workflow", source: this.source, statements },
      diagnostics: this.diagnostics,
      ...(this.returnType ? { returnType: this.returnType } : {})
    };
  }

  private collectSyntaxErrors(node: SyntaxNode): void {
    if (node.type.isError) {
      this.error("Invalid Python syntax.", node.from, Math.max(node.from + 1, node.to));
    }
    for (const child of children(node)) this.collectSyntaxErrors(child);
  }

  private compileStatements(container: SyntaxNode): WorkflowStatement[] {
    const statements: WorkflowStatement[] = [];
    for (const node of children(container)) {
      if (node.name === "Comment" || node.name === ":") continue;
      const statement = this.compileStatement(node);
      if (statement) statements.push(statement);
    }
    return statements;
  }

  private compileStatement(node: SyntaxNode): WorkflowStatement | undefined {
    if (node.name === "ImportStatement") {
      const raw = this.source.slice(node.from, node.to).trim();
      if (!this.options.allowImports) {
        this.error("Import is not allowed in this context.", node.from, node.to);
      } else if (!this.validImport(raw)) {
        this.error("Imported API is not defined.", node.from, node.to);
      }
      return undefined;
    }
    if (node.name === "AssignStatement") return this.compileAssignment(node);
    if (node.name === "ExpressionStatement") return this.compileExpressionStatement(node);
    if (node.name === "IfStatement") return this.compileIf(node);
    if (node.name === "ReturnStatement") {
      if (!this.options.allowReturn) {
        this.error("return is only allowed in a custom API main function.", node.from, node.to);
        return undefined;
      }
      const expressionNode = namedChildren(node).at(-1);
      const value = expressionNode ? this.compileExpression(expressionNode) : undefined;
      if (!value) {
        this.error("A custom API main function must return a value.", node.from, node.to);
        return undefined;
      }
      this.returnExpression = value.expression;
      this.returnType = value.type;
      return undefined;
    }
    this.error(
      `${node.name.replace(/Statement$/, "")} is not allowed in Dext workflows.`,
      node.from,
      node.to
    );
    return undefined;
  }

  private compileAssignment(node: SyntaxNode): WorkflowStatement | undefined {
    const parts = namedChildren(node);
    const variable = parts.find((child) => child.name === "VariableName");
    const callNode = parts.find((child) => child.name === "CallExpression");
    if (!variable || !callNode) {
      this.error("Assignments must bind the result of a Dext API call.", node.from, node.to);
      return undefined;
    }
    const name = text(this.source, variable);
    if (this.environment.has(name)) {
      this.error(`Variable '${name}' cannot be reassigned.`, variable.from, variable.to);
      return undefined;
    }
    const compiled = this.compileCall(callNode, false);
    if (!compiled) return undefined;
    this.environment.set(name, { type: compiled.type, from: variable.from });
    return { kind: "step", assignment: name, call: compiled.call, from: node.from, to: node.to };
  }

  private compileExpressionStatement(node: SyntaxNode): WorkflowStatement | undefined {
    const callNode = namedChildren(node).find((child) => child.name === "CallExpression");
    if (!callNode) {
      this.error("Only Dext API calls may be used as expression statements.", node.from, node.to);
      return undefined;
    }
    const compiled = this.compileCall(callNode, false);
    return compiled
      ? { kind: "step", call: compiled.call, from: node.from, to: node.to }
      : undefined;
  }

  private compileIf(node: SyntaxNode): WorkflowStatement | undefined {
    const parts = children(node);
    const conditionNode = parts.find((child) => child.name === "BinaryExpression" || child.name === "Boolean" || child.name === "MemberExpression");
    const bodies = parts.filter((child) => child.name === "Body");
    if (!conditionNode || !bodies[0]) {
      this.error("An if statement requires a condition and body.", node.from, node.to);
      return undefined;
    }
    const condition = this.compileCondition(conditionNode);
    if (!condition) return undefined;
    const before = new Map(this.environment);
    const consequent = this.compileStatements(bodies[0]);
    const afterConsequent = new Map(this.environment);
    this.environment.clear();
    for (const entry of before) this.environment.set(...entry);
    const alternate = bodies[1] ? this.compileStatements(bodies[1]) : [];
    const afterAlternate = new Map(this.environment);
    this.environment.clear();
    for (const entry of before) this.environment.set(...entry);
    for (const [name, entry] of afterConsequent) {
      const alternateEntry = afterAlternate.get(name);
      if (alternateEntry && typeName(entry.type) === typeName(alternateEntry.type)) {
        this.environment.set(name, entry);
      }
    }
    return {
      kind: "if",
      condition,
      consequent,
      alternate,
      from: node.from,
      to: node.to
    };
  }

  private compileCondition(node: SyntaxNode): WorkflowCondition | undefined {
    if (node.name === "BinaryExpression") {
      const parts = namedChildren(node);
      const operator = children(node).find((child) => child.name === "CompareOp");
      if (!operator || !["==", "!="].includes(text(this.source, operator))) {
        this.error("Dext conditions currently support only == and !=.", node.from, node.to);
        return undefined;
      }
      const left = parts[0] ? this.compileExpression(parts[0]) : undefined;
      const right = parts.at(-1) ? this.compileExpression(parts.at(-1)!) : undefined;
      if (!left || !right) return undefined;
      if (!typesOverlap(left.type, right.type)) {
        this.error(
          `Cannot compare ${typeName(left.type)} with ${typeName(right.type)}.`,
          right.expression.from,
          right.expression.to
        );
      } else {
        validateStringLiteralComparison(left.type, right.expression, this.diagnostics);
        validateStringLiteralComparison(right.type, left.expression, this.diagnostics);
      }
      return {
        kind: "comparison",
        operator: text(this.source, operator) as "==" | "!=",
        left: left.expression,
        right: right.expression,
        from: node.from,
        to: node.to
      };
    }
    const value = this.compileExpression(node);
    if (!value) return undefined;
    if (value.type.kind !== "boolean") {
      this.error("An if condition must be boolean.", node.from, node.to);
    }
    return { kind: "boolean", value: value.expression, from: node.from, to: node.to };
  }

  private compileCall(node: SyntaxNode, referenceOnly: boolean): { call: WorkflowCall; type: ValueType } | undefined {
    const parts = namedChildren(node);
    const callee = parts[0];
    const args = parts.find((child) => child.name === "ArgList");
    const rawMethod = callee ? memberPath(this.source, callee) : undefined;
    const method = rawMethod ? resolveAlias(rawMethod, this.options.aliases) : undefined;
    if (!method || !args) {
      this.error("Invalid API call.", node.from, node.to);
      return undefined;
    }
    if (method === "ref.file" || method === "ref.symbol" || method === "ref.dir") {
      if (!referenceOnly) this.error("Reference constructors are values, not workflow steps.", node.from, node.to);
      return undefined;
    }
    const definition = this.registry.get(method);
    if (!definition) {
      this.error(`Unknown Dext API '${method}'.`, callee?.from ?? node.from, callee?.to ?? node.to);
      return undefined;
    }
    if (
      definition.executor.kind === "custom"
      && this.options.customApiIds?.has(method)
      && this.options.requireCustomApiImports !== false
      && !this.options.aliases?.has(rawMethod ?? "")
      && !this.options.aliases?.has(rawMethod?.split(".")[0] ?? "")
    ) {
      this.error(`Custom API '${method}' must be imported before use.`, callee?.from ?? node.from, callee?.to ?? node.to);
      return undefined;
    }
    const values = this.compileArguments(args, definition);
    return {
      call: { kind: "call", method, arguments: values, from: node.from, to: node.to },
      type: outputType(definition)
    };
  }

  private compileArguments(node: SyntaxNode, definition: CallableDefinition): WorkflowCall["arguments"] {
    const parts = children(node);
    const values: WorkflowCall["arguments"] = [];
    const seen = new Set<string>();
    for (let index = 0; index < parts.length; index += 1) {
      const nameNode = parts[index];
      if (nameNode?.name !== "VariableName" || parts[index + 1]?.name !== "AssignOp") continue;
      const valueNode = parts[index + 2];
      const name = text(this.source, nameNode);
      if (!valueNode) continue;
      const field = definition.input.find((candidate) => candidate.name === name);
      if (!field) {
        this.error(`Unknown argument '${name}' for '${definition.id}'.`, nameNode.from, nameNode.to);
        continue;
      }
      if (seen.has(name)) this.error(`Argument '${name}' is provided more than once.`, nameNode.from, nameNode.to);
      seen.add(name);
      const compiled = this.compileExpression(valueNode);
      if (compiled) {
        if (!matchesField(compiled.type, field)) {
          this.error(`Argument '${name}' expects ${fieldTypeName(field)}, not ${typeName(compiled.type)}.`, valueNode.from, valueNode.to);
        }
        values.push({ name, value: compiled.expression, from: nameNode.from, to: valueNode.to });
      }
      index += 2;
    }
    for (const field of definition.input) {
      if (field.required && field.default === undefined && !seen.has(field.name)) {
        this.error(`Missing required argument '${field.name}'.`, node.from, node.to);
      }
    }
    const positional = namedChildren(node).filter((part) =>
      !["VariableName", "AssignOp"].includes(part.name)
      && !values.some((value) => value.to === part.to)
    );
    if (positional.length) this.error("Dext API calls require keyword arguments.", positional[0]!.from, positional[0]!.to);
    return values;
  }

  private compileExpression(node: SyntaxNode): { expression: WorkflowExpression; type: ValueType } | undefined {
    if (node.name === "String") {
      return {
        expression: { kind: "literal", value: decodeString(text(this.source, node)), from: node.from, to: node.to },
        type: { kind: "string" }
      };
    }
    if (node.name === "Number") {
      return {
        expression: { kind: "literal", value: Number(text(this.source, node)), from: node.from, to: node.to },
        type: { kind: "number" }
      };
    }
    if (node.name === "Boolean") {
      return {
        expression: { kind: "literal", value: text(this.source, node) === "True", from: node.from, to: node.to },
        type: { kind: "boolean" }
      };
    }
    if (node.name === "ArrayExpression") {
      const compiled = namedChildren(node).map((child) => this.compileExpression(child)).filter((value) => value !== undefined);
      const first = compiled[0]?.type ?? { kind: "unknown" as const };
      const item = compiled.every((value) => typeName(value.type) === typeName(first))
        ? first
        : { kind: "unknown" as const };
      return {
        expression: { kind: "list", values: compiled.map((value) => value.expression), from: node.from, to: node.to },
        type: { kind: "list", item }
      };
    }
    if (node.name === "DictionaryExpression") {
      const entries: Extract<WorkflowExpression, { kind: "object" }>['entries'] = [];
      const seen = new Set<string>();
      const parts = children(node);
      for (let index = 0; index < parts.length; index += 1) {
        const key = parts[index];
        if (key?.name !== "String") continue;
        const colon = parts[index + 1];
        const value = parts[index + 2];
        if (colon?.name !== ":" || !value) continue;
        const name = decodeString(text(this.source, key));
        if (seen.has(name)) this.error(`Dictionary key '${name}' is provided more than once.`, key.from, key.to);
        seen.add(name);
        const compiled = this.compileExpression(value);
        if (compiled) entries.push({ key: name, value: compiled.expression, from: key.from, to: value.to });
        index += 2;
      }
      const invalidKey = parts.find((part, index) => part.name === ":" && parts[index - 1]?.name !== "String");
      if (invalidKey) this.error("Dext dictionary keys must be strings.", invalidKey.from, invalidKey.to);
      return {
        expression: { kind: "object", entries, from: node.from, to: node.to },
        type: { kind: "object" }
      };
    }
    if (node.name === "VariableName") {
      const name = text(this.source, node);
      const entry = this.environment.get(name);
      if (!entry) {
        this.error(`Unknown variable '${name}'.`, node.from, node.to);
        return undefined;
      }
      return { expression: { kind: "variable", name, from: node.from, to: node.to }, type: entry.type };
    }
    if (node.name === "MemberExpression") {
      const path = memberPath(this.source, node);
      if (path === "ref.selection" || path === "ref.active_file") {
        const reference: ContextReference = path.endsWith("selection")
          ? { kind: "selection" }
          : { kind: "activeFile" };
        return { expression: { kind: "reference", reference, from: node.from, to: node.to }, type: { kind: "context" } };
      }
      const parts = namedChildren(node);
      const object = parts[0] ? this.compileExpression(parts[0]) : undefined;
      const property = parts[1] ? text(this.source, parts[1]) : "";
      if (!object) return undefined;
      if (object.type.kind !== "result" || !object.type.fields[property]) {
        this.error(`'${typeName(object.type)}' has no field '${property}'.`, node.from, node.to);
        return undefined;
      }
      return {
        expression: { kind: "member", object: object.expression, property, from: node.from, to: node.to },
        type: object.type.fields[property]
      };
    }
    if (node.name === "CallExpression") {
      const path = memberPath(this.source, namedChildren(node)[0]!);
      const args = namedChildren(node).find((child) => child.name === "ArgList");
      if ((path === "ref.file" || path === "ref.symbol" || path === "ref.dir") && args) {
        const values = namedChildren(args);
        if (values.length !== 1 || values[0]?.name !== "String") {
          this.error(`${path} requires exactly one string argument.`, args.from, args.to);
          return undefined;
        }
        const value = decodeString(text(this.source, values[0]));
        const reference: ContextReference | DirectoryReference = path === "ref.file"
          ? { kind: "file", path: value }
          : path === "ref.symbol"
            ? { kind: "symbol", name: value }
            : { kind: "dir", path: value };
        return {
          expression: { kind: "reference", reference, from: node.from, to: node.to },
          type: path === "ref.dir" ? { kind: "dir" } : { kind: "context" }
        };
      }
      if (this.options.allowNestedCalls && args) {
        const method = path ? resolveAlias(path, this.options.aliases) : undefined;
        const definition = method ? this.registry.get(method) : undefined;
        if (!method || !definition) {
          this.error(`Unknown Dext API '${path ?? ""}'.`, node.from, node.to);
          return undefined;
        }
        if (
          definition.executor.kind === "custom"
          && this.options.customApiIds?.has(method)
          && this.options.requireCustomApiImports !== false
          && !this.options.aliases?.has(path ?? "")
          && !this.options.aliases?.has(path?.split(".")[0] ?? "")
        ) {
          this.error(`Custom API '${method}' must be imported before use.`, node.from, node.to);
          return undefined;
        }
        const values = this.compileArguments(args, definition);
        return {
          expression: { kind: "call", call: { kind: "call", method, arguments: values, from: node.from, to: node.to }, from: node.from, to: node.to },
          type: outputType(definition)
        };
      }
      this.error("Nested calls are limited to ref.file(...), ref.dir(...), and ref.symbol(...).", node.from, node.to);
      return undefined;
    }
    this.error(`Expression '${node.name}' is not allowed in Dext workflows.`, node.from, node.to);
    return undefined;
  }

  private error(message: string, from: number, to: number): void {
    this.diagnostics.push({ message, severity: "error", from, to: Math.max(from + 1, to) });
  }

  private validImport(raw: string): boolean {
    const match = /^(?:from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+[A-Za-z_][A-Za-z0-9_]*|import\s+([A-Za-z_][A-Za-z0-9_.]*))/.exec(raw);
    const imported = match?.[1] ?? match?.[2];
    if (!imported || !this.options.customApiIds) return false;
    return [...this.options.customApiIds].some((id) => id === imported || id.startsWith(`${imported}.`));
  }

  returnExpression: WorkflowExpression | undefined;
  returnType: ValueType | undefined;
}

function fieldType(field: FieldDefinition): ValueType {
  let value: ValueType;
  if (field.type === "enum") value = field.values
    ? { kind: "string", literals: field.values }
    : { kind: "string" };
  else if (field.type === "context") value = { kind: "context" };
  else if (field.type === "dir") value = { kind: "dir" };
  else if (field.type === "object") value = { kind: "object" };
  else if (field.type === "result") value = result("Result", {});
  else value = { kind: field.type };
  return field.multiple ? { kind: "list", item: value } : value;
}

function outputType(definition: CallableDefinition): ValueType {
  if (!definition.output.fields) return RESULT_TYPES[definition.output.kind] ?? { kind: "unknown" };
  const fields: Record<string, ValueType> = {};
  for (const field of definition.output.fields) fields[field.name] = fieldType(field);
  return result(definition.output.resultType ?? `${definition.output.kind}Result`, fields);
}

function matchesField(actual: ValueType, field: FieldDefinition): boolean {
  if (actual.kind === "unknown") return true;
  return [field.type, ...(field.accepts ?? [])].some((type) => {
    const expected = fieldType({ ...field, type, ...(field.accepts ? { accepts: [] } : {}) });
    if (field.multiple && expected.kind === "list") {
      return actual.kind === expected.item.kind
        || (actual.kind === "list" && actual.item.kind === expected.item.kind);
    }
    return expected.kind === "result"
      ? actual.kind === "result"
      : actual.kind === expected.kind;
  });
}

function typesOverlap(left: ValueType, right: ValueType): boolean {
  if (left.kind === "unknown" || right.kind === "unknown") return true;
  return left.kind === right.kind;
}

function validateStringLiteralComparison(
  constrained: ValueType,
  candidate: WorkflowExpression,
  diagnostics: WorkflowDiagnostic[]
): void {
  if (
    constrained.kind !== "string"
    || !constrained.literals
    || candidate.kind !== "literal"
    || typeof candidate.value !== "string"
    || constrained.literals.includes(candidate.value)
  ) {
    return;
  }
  diagnostics.push({
    message: `Expected one of ${constrained.literals.map((value) => `"${value}"`).join(", ")}.`,
    severity: "error",
    from: candidate.from,
    to: candidate.to
  });
}

function fieldTypeName(field: FieldDefinition): string {
  return [field.type, ...(field.accepts ?? [])].map((type) => typeName(fieldType({ ...field, type, ...(field.accepts ? { accepts: [] } : {}) }))).join(" | ");
}

function typeName(type: ValueType): string {
  if (type.kind === "list") return `${typeName(type.item)}[]`;
  if (type.kind === "result") return type.name;
  if (type.kind === "object") return "dict[str, object]";
  return type.kind;
}

export function compileWorkflow(
  source: string,
  registry: MethodRegistry,
  options: WorkflowCompileOptions = {}
): WorkflowCompileResult {
  const compiler = new Compiler(normalizeInputReferenceSource(source), registry, options);
  const result = compiler.compile();
  if (result.program && compiler.returnExpression) {
    result.program.returnExpression = compiler.returnExpression;
  }
  if (compiler.returnType) result.returnType = compiler.returnType;
  return result;
}

export function parseWorkflowImports(source: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    let match = /^from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(trimmed);
    if (match) {
      imports.set(match[3] ?? match[2]!, `${match[1]}.${match[2]}`);
      continue;
    }
    match = /^import\s+([A-Za-z_][A-Za-z0-9_.]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(trimmed);
    if (match) imports.set(match[2] ?? match[1]!.split(".").at(-1)!, match[1]!);
  }
  return imports;
}
