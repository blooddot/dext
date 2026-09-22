import { uiOutputFields } from "./builtins.js";
import { parseUiForm } from "./uiForm.js";
import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import type { MethodRegistry } from "./registry.js";
import { normalizeInputReferenceSource } from "./fileReference.js";
import { CLI_BUILTIN_IDS, specializeBuiltinCli } from "./builtinCli.js";
import {
  PURE_FUNCTIONS,
  STRING_METHODS,
  formatReplacement,
  pythonArithmetic,
  pythonCompare,
  pythonIndex,
  pythonSlice,
  pythonTruthy,
  pureFunction,
  stringMethod,
  type ArithmeticOperator,
  type CompareOperator,
  type FormatConversion,
  type LogicalOperator,
  type PureReturn,
  type PureSignature
} from "./pythonStrings.js";
import type {
  CallableDefinition,
  ContextReference,
  DirectoryReference,
  FieldDefinition,
  WorkflowArgument,
  WorkflowCall,
  WorkflowCondition,
  WorkflowExpression,
  WorkflowFormatPart,
  WorkflowProgram,
  WorkflowStatement
} from "./types.js";

export interface WorkflowDiagnostic {
  code?: string;
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
  | { kind: "object"; item?: ValueType }
  | { kind: "list"; item: ValueType }
  | { kind: "result"; name: string; fields: Readonly<Record<string, ValueType>> }
  | { kind: "unknown" };

export type WorkflowValueType = ValueType;

interface Compiled {
  expression: WorkflowExpression;
  type: ValueType;
}

const COMPARE_OPERATORS: readonly CompareOperator[] = ["==", "!=", "<", "<=", ">", ">=", "in", "not in"];

/** Lists longer than this stay runtime values instead of becoming AST nodes. */
const MAX_FOLDED_ITEMS = 100;

function isCompareOperator(operator: string): operator is CompareOperator {
  return (COMPARE_OPERATORS as readonly string[]).includes(operator);
}

function pureValueType(returns: PureReturn): ValueType {
  if (returns.kind === "list") return { kind: "list", item: pureValueType({ kind: returns.item ?? "unknown" }) };
  return { kind: returns.kind };
}

/** `sorted(items)` and friends keep the element type they were given. */
function pureElementValueType(type: ValueType): ValueType {
  if (type.kind === "list") return { kind: "list", item: type.item };
  return { kind: "list", item: { kind: "unknown" } };
}

/** An `else` branch always runs when reached, so its condition is trivially true. */
function trueCondition(node: SyntaxNode): WorkflowCondition {
  return {
    kind: "boolean",
    value: { kind: "literal", value: true, from: node.from, to: node.from + 1 },
    from: node.from,
    to: node.from + 1
  };
}

/** The item type of a list or tuple literal: the shared type of its entries. */
function sequenceItemType(values: readonly Compiled[]): ValueType {
  const first = values[0]?.type ?? { kind: "unknown" as const };
  return values.every((value) => typeName(value.type) === typeName(first)) ? first : { kind: "unknown" };
}

function argumentOf(value: Compiled, name: string | undefined): WorkflowArgument {  return {
    ...(name ? { name } : {}),
    value: value.expression,
    from: value.expression.from,
    to: value.expression.to
  };
}

/** Joins neighboring text pieces so an f-string with escapes stays one run. */
function mergeTextParts(parts: readonly WorkflowFormatPart[]): WorkflowFormatPart[] {
  const merged: WorkflowFormatPart[] = [];
  for (const part of parts) {
    const previous = merged.at(-1);
    if (part.kind === "text" && previous?.kind === "text") {
      merged[merged.length - 1] = { kind: "text", text: previous.text + part.text };
      continue;
    }
    merged.push(part);
  }
  return merged;
}

function arityText(signature: PureSignature): string {
  if (signature.maximum === Infinity) return `at least ${signature.required} argument${signature.required === 1 ? "" : "s"}`;
  if (signature.required === signature.maximum) return `${signature.required} argument${signature.required === 1 ? "" : "s"}`;
  return `${signature.required} to ${signature.maximum} arguments`;
}

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
  /** 字面量变量的值表达式，用于在引用处内联展开。 */
  value?: WorkflowExpression;
}

const RESULT_TYPES: Readonly<Record<string, ValueType>> = {
  ask: result("AskResult", { text: { kind: "string" } }),
  plan: result("PlanResult", { text: { kind: "string" } }),
  skill: result("SkillResult", { text: { kind: "string" } }),
  agent: result("AgentResult", {
    text: { kind: "string" },
    summary: { kind: "string" },
    patch: result("PatchResult", {
      title: { kind: "string" },
      changes: { kind: "list", item: { kind: "unknown" } }
    }),
    files: { kind: "list", item: { kind: "context" } }
  }),
  template: result("TemplateResult", {
    text: { kind: "string" }
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
  patch: result("PatchResult", {
    title: { kind: "string" },
    changes: { kind: "list", item: { kind: "unknown" } }
  }),
  ui: result("UiResult", {
    type: { kind: "string", literals: ["select", "radio", "checkbox", "confirm", "input", "form", "alert"] },
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

/** 把变量类型注解（如 ": str"、": list[str]"）解析为编译期 ValueType。 */
function parseValueType(raw: string): ValueType | undefined {
  const normalized = raw.replace(/^\s*:\s*/, "").replace(/\s+/g, "");
  if (/^(str|string)$/i.test(normalized)) return { kind: "string" };
  if (/^(int|float|number)$/i.test(normalized)) return { kind: "number" };
  if (/^(bool|boolean)$/i.test(normalized)) return { kind: "boolean" };
  if (/^(object|dict\[str,(object|Any|unknown)\])$/i.test(normalized)) return { kind: "object" };
  const list = /^list\[(.+)\]$/i.exec(normalized);
  if (list) {
    const item = parseValueType(list[1]!);
    return item ? { kind: "list", item } : undefined;
  }
  return undefined;
}

/** 检查声明类型与字面量推断类型是否一致（list 递归比较元素）。 */
function typesMatch(declared: ValueType, actual: ValueType): boolean {
  if (declared.kind === "unknown" || actual.kind === "unknown") return true;
  if (declared.kind === "list" && actual.kind === "list") return typesMatch(declared.item, actual.item);
  return declared.kind === actual.kind;
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

interface StringLiteralShape {
  prefix: string;
  quote: string;
  body: string;
  raw: boolean;
  formatted: boolean;
  bytes: boolean;
}

/** Splits a Python string literal into prefix, quote, and body. */
function parseStringLiteral(value: string): StringLiteralShape | undefined {
  const match = /^([A-Za-z]*)("""|'''|"|')/.exec(value);
  if (!match) return undefined;
  const prefix = match[1] ?? "";
  const quote = match[2]!;
  if (!value.endsWith(quote) || value.length < prefix.length + quote.length * 2) return undefined;
  return {
    prefix,
    quote,
    body: value.slice(prefix.length + quote.length, value.length - quote.length),
    raw: /r/i.test(prefix),
    formatted: /f/i.test(prefix),
    bytes: /b/i.test(prefix)
  };
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  n: "\n",
  r: "\r",
  t: "\t",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  "0": "\0"
};

/** Decodes Python escape sequences. Unknown escapes stay as they were written,
 * which matches Python's behavior outside of a SyntaxWarning. */
function decodeEscapes(value: string): string {
  return value.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)/gs, (whole, escaped: string) => {
    if (escaped.startsWith("x")) return String.fromCodePoint(parseInt(escaped.slice(1), 16));
    if (escaped.startsWith("u")) return String.fromCodePoint(parseInt(escaped.slice(1), 16));
    if (escaped.startsWith("U")) return String.fromCodePoint(parseInt(escaped.slice(1), 16));
    if (/^[0-7]+$/.test(escaped)) return String.fromCodePoint(parseInt(escaped, 8));
    return SIMPLE_ESCAPES[escaped] ?? whole;
  });
}

function decodeStringBody(value: string, raw: boolean): string {
  return raw ? value : decodeEscapes(value);
}

/** Decodes one plain string literal node's source text. */
function decodeStringLiteral(value: string): string | undefined {
  const literal = parseStringLiteral(value);
  if (!literal || literal.formatted || literal.bytes) return undefined;
  return decodeStringBody(literal.body, literal.raw);
}

/** Text between f-string replacement fields: `{{`/`}}` are the escapes, and a
 * non-raw f-string decodes backslashes as well. */
function decodeFormatText(value: string, raw: boolean): string {
  const unbraced = value.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
  return raw ? unbraced : decodeEscapes(unbraced);
}

/** Python number literals: underscores, hex/octal/binary prefixes, and floats. */
function numberLiteral(value: string): number {
  const normalized = value.replaceAll("_", "");
  if (/^[+-]?0[xX]/.test(normalized)) return Number.parseInt(normalized.replace(/^[+-]?0[xX]/, ""), 16) * (normalized.startsWith("-") ? -1 : 1);
  if (/^[+-]?0[oO]/.test(normalized)) return Number.parseInt(normalized.replace(/^[+-]?0[oO]/, ""), 8) * (normalized.startsWith("-") ? -1 : 1);
  if (/^[+-]?0[bB]/.test(normalized)) return Number.parseInt(normalized.replace(/^[+-]?0[bB]/, ""), 2) * (normalized.startsWith("-") ? -1 : 1);
  return Number(normalized);
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

/** The Python grammar treats `-` as subtraction, but MCP server/tool names are
 * allowed to contain hyphens. Replace eligible hyphens outside strings/comments
 * with a parser-safe Unicode identifier character. It is one UTF-16 code unit,
 * so syntax-node offsets still point into the original source retained below. */
export function parserCompatibleSource(source: string): string {
  // Split into UTF-16 code units so replacement never shifts parser offsets.
  const chars = source.split("");
  let quote: "'" | '"' | undefined;
  let triple = false;
  let escaped = false;
  let comment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index];
    if (comment) {
      if (character === "\n" || character === "\r") comment = false;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        quote = undefined;
        triple = false;
        index += 2;
      } else if (!triple && character === quote) quote = undefined;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      triple = source.slice(index, index + 3) === character.repeat(3);
      if (triple) index += 2;
      continue;
    }
    if (
      character === "-"
      && /[A-Za-z0-9_]/.test(chars[index - 1] ?? "")
      && /[A-Za-z0-9_]/.test(chars[index + 1] ?? "")
    ) chars[index] = "﹣";
  }
  return chars.join("");
}

class Compiler {
  private readonly diagnostics: WorkflowDiagnostic[] = [];
  private readonly environment = new Map<string, EnvironmentEntry>();
  /** Names bound by more than one assignment, and therefore materialized at
   * runtime instead of inlined. Filled from the whole source before compiling. */
  private readonly reassignedNames = new Set<string>();

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
    const tree = parser.parse(parserCompatibleSource(this.source));
    this.collectSyntaxErrors(tree.topNode);
    this.collectReassignedNames(tree.topNode);
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

  /** A name written twice is reassigned: every read of it has to see the value
   * the runtime holds at that point. A loop or a branch compiles its body once
   * but runs it many times, so such a name cannot be inlined — the constant
   * folded into the body would stay the first value on every later pass. */
  private collectReassignedNames(root: SyntaxNode): void {
    const counts = new Map<string, number>();
    const visit = (node: SyntaxNode): void => {
      // A nested function has its own scope, and Dext rejects one anyway.
      if (node !== root && node.name === "FunctionDefinition") return;
      if (node.name === "AssignStatement") {
        const parts = children(node);
        const assignIndex = parts.findIndex((child) => child.name === "AssignOp");
        const targets = assignIndex > 0 ? parts.slice(0, assignIndex).filter((child) => child.name === "VariableName") : [];
        if (targets.length === 1) {
          const name = text(this.source, targets[0]!);
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
      for (const child of children(node)) visit(child);
    };
    visit(root);
    for (const [name, count] of counts) {
      if (count > 1) this.reassignedNames.add(name);
    }
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
    if (node.name === "ForStatement") return this.compileFor(node);
    if (node.name === "WhileStatement") return this.compileWhile(node);
    if (node.name === "TryStatement") return this.compileTry(node);
    if (node.name === "ReturnStatement") {
      if (!this.options.allowReturn) {
        this.error("return is only allowed in a custom API function.", node.from, node.to);
        return undefined;
      }
      const expressionNode = namedChildren(node).at(-1);
      const reported = this.diagnostics.length;
      const value = expressionNode ? this.compileExpression(expressionNode) : undefined;
      if (!value) {
        // A failed expression already reported the actionable error. Repeating
        // it as "must return a value" would only be cascade noise in Problems.
        if (this.diagnostics.length === reported) this.error("A custom API function must return a value.", node.from, node.to);
        return undefined;
      }
      if (this.returnType && typeName(this.returnType) !== typeName(value.type) && !(isUiResultType(this.returnType) && isUiResultType(value.type))) {
        this.error(
          `All return statements must return the same type (already ${typeName(this.returnType)}, got ${typeName(value.type)}).`,
          node.from,
          node.to
        );
      }
      this.returnExpression = value.expression;
      if (this.returnType && isUiResultType(this.returnType) && isUiResultType(value.type) && typeName(this.returnType) !== typeName(value.type)) this.returnType = RESULT_TYPES.ui;
      if (!this.returnType) this.returnType = value.type;
      return { kind: "return", expression: value.expression, from: node.from, to: node.to };
    }
    if (node.name === "UpdateStatement") {
      // Python's `+=` mutates in place. A Dext assignment writes a value to a
      // name, so the same effect is an ordinary reassignment.
      const operator = children(node).find((child) => child.name === "UpdateOp");
      this.error(
        `Dext does not support '${operator ? text(this.source, operator) : "augmented assignment"}'. `
        + "Write the reassignment out (for example 'total = total + item'), "
        + 'or collect the values in a list and join them, for example "\\n".join(lines).',
        node.from,
        node.to
      );
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
    // One target, one value. `a, b = value` and `x = 1, 2` parse as ordinary
    // assignment statements, so without this check the extra names and values
    // would silently disappear.
    const shape = this.assignmentShape(parts, node);
    if (!shape) return undefined;
    const { variable, values } = shape;
    const name = text(this.source, variable);
    const existing = this.environment.get(name);
    // `x = 1, 2` is a tuple in Python, so it is a list here.
    const compiled = values.length === 1
      ? this.assignmentExpression(values[0]!)
      : this.compileSequence(values, node);
    if (!compiled) return undefined;
    const typeDef = parts.find((child) => child.name === "TypeDef");
    let type = compiled.type;
    if (typeDef) {
      const declared = parseValueType(text(this.source, typeDef));
      if (!declared) {
        this.error(`Unsupported variable type annotation '${text(this.source, typeDef)}'.`, typeDef.from, typeDef.to);
        return undefined;
      }
      if (!typesMatch(declared, compiled.type)) {
        this.error(
          `Variable '${name}' is declared as ${typeName(declared)} but assigned ${typeName(compiled.type)}.`,
          node.from,
          node.to
        );
        return undefined;
      }
      type = declared;
    }
    if (existing && typeName(existing.type) !== typeName(type)) {
      // Reassignment is ordinary control flow, but a name keeps its type: a
      // variable that changed type would make every later read, branch merge,
      // and API argument check depend on which path actually ran.
      this.error(
        `Variable '${name}' must keep type ${typeName(existing.type)}; it cannot be reassigned to ${typeName(type)}.`,
        variable.from,
        variable.to,
        "dext/reassign"
      );
      return undefined;
    }
    if (compiled.expression.kind === "call") {
      this.environment.set(name, { type, from: variable.from });
      return { kind: "step", assignment: name, call: compiled.expression.call, from: node.from, to: node.to };
    }
    // A value Dext can compute while compiling never reaches the runtime; it is
    // stored and inlined where the variable is used, exactly like a literal.
    // A reassigned name is the exception: it keeps a runtime slot so a later
    // read — a loop condition, a branch, or simply the next statement — sees
    // the value written by the last assignment that ran.
    if (!this.reassignedNames.has(name) && this.inlineable(compiled.expression)) {
      this.environment.set(name, { type, from: variable.from, value: compiled.expression });
      return undefined;
    }
    this.environment.set(name, { type, from: variable.from });
    return { kind: "assign", assignment: name, expression: compiled.expression, from: node.from, to: node.to };
  }

  /** The right-hand side of an assignment: a Dext API call stays the step it has
   * always been, while a pure expression (including string methods and helpers)
   * compiles as a value. */
  private assignmentExpression(valueNode: SyntaxNode): Compiled | undefined {
    if (valueNode.name === "CallExpression") return this.compileCallAsExpression(valueNode);
    return this.compileExpression(valueNode);
  }

  /** Resolves a call in value position: a pure helper or string method first,
   * then a Dext API call. */
  private compileCallAsExpression(node: SyntaxNode): Compiled | undefined {
    const parts = namedChildren(node);
    const callee = parts[0];
    const args = parts.find((child) => child.name === "ArgList");
    if (!callee || !args) {
      this.error("Invalid API call.", node.from, node.to);
      return undefined;
    }
    const pure = this.compilePureCall(callee, args, node);
    if (pure === null) return undefined;
    if (pure) return this.foldConstant(pure);
    const call = this.compileCall(node);
    return call
      ? { expression: { kind: "call", call: call.call, from: node.from, to: node.to }, type: call.type }
      : undefined;
  }

  /** Literal containers are inlined the way they always were, and any expression
   * the compiler could evaluate joins them: it is cheaper to substitute the
   * value than to emit a step that only copies it. Anything the runtime has to
   * compute (a variable, a member read, a computed string) becomes a step. */
  private inlineable(expression: WorkflowExpression): boolean {
    if (["literal", "list", "object"].includes(expression.kind)) return true;
    return this.safeConstantValue(expression) !== undefined;
  }

  /** Constant folding for checks that only care whether a value is known. */
  private safeConstantValue(expression: WorkflowExpression): unknown {
    try {
      return this.constantValue(expression)?.value;
    } catch {
      return undefined;
    }
  }

  /** Validates the `name = value` shape and returns its two ends. A tuple on the
   * right is allowed: `x = 1, 2` binds one list. */
  private assignmentShape(
    parts: readonly SyntaxNode[],
    node: SyntaxNode
  ): { variable: SyntaxNode; values: SyntaxNode[] } | undefined {
    const assignIndex = parts.findIndex((child) => child.name === "AssignOp");
    if (assignIndex < 0) {
      this.error("Assignments must use '='.", node.from, node.to);
      return undefined;
    }
    if (parts.filter((child) => child.name === "AssignOp").length > 1) {
      this.error("Dext assigns one variable at a time; chained assignment is not supported.", node.from, node.to);
      return undefined;
    }
    const targets = parts.slice(0, assignIndex).filter((child) => child.name !== "TypeDef" && child.name !== "Comment");
    const values = parts.slice(assignIndex + 1).filter((child) => child.name !== "Comment");
    if (targets.length !== 1 || targets[0]!.name !== "VariableName") {
      this.error(
        "Dext assigns one variable at a time; unpacking such as 'a, b = value' is not supported.",
        node.from,
        node.to
      );
      return undefined;
    }
    if (!values.length) {
      this.error("Assignments must bind the result of a Dext API call or a value expression.", node.from, node.to);
      return undefined;
    }
    return { variable: targets[0]!, values };
  }

  private compileExpressionStatement(node: SyntaxNode): WorkflowStatement | undefined {    const callNode = namedChildren(node).find((child) => child.name === "CallExpression");
    if (!callNode) {
      this.error("Only Dext API calls may be used as expression statements.", node.from, node.to);
      return undefined;
    }
    const compiled = this.compileCall(callNode);
    return compiled
      ? { kind: "step", call: compiled.call, from: node.from, to: node.to }
      : undefined;
  }

  /** `if`/`elif`/`else`. Branches are compiled independently and only bindings
   * every surviving branch agrees on escape, because at compile time it is not
   * known which one runs. */
  private compileIf(node: SyntaxNode): WorkflowStatement | undefined {
    const branches = this.ifBranches(node);
    if (!branches) {
      this.error("An if statement requires a condition and body.", node.from, node.to);
      return undefined;
    }
    return this.compileBranch(branches, 0, node);
  }

  private compileBranch(
    branches: readonly { condition?: SyntaxNode; body: SyntaxNode }[],
    index: number,
    node: SyntaxNode
  ): WorkflowStatement | undefined {
    const branch = branches[index]!;
    const before = new Map(this.environment);
    const condition = branch.condition ? this.compileCondition(branch.condition) : undefined;
    if (branch.condition && !condition) return undefined;
    const consequent = this.compileStatements(branch.body);
    const afterConsequent = new Map(this.environment);
    // The last branch has nothing to reconcile with: an `else` binds
    // unconditionally, while an `if` without `else` leaves a path that binds
    // nothing at all.
    if (index + 1 >= branches.length) {
      if (branch.condition !== undefined) this.restore(before);
      return {
        kind: "if",
        condition: condition ?? trueCondition(node),
        consequent,
        alternate: [],
        from: node.from,
        to: node.to
      };
    }
    this.restore(before);
    const alternate = [this.compileBranch(branches, index + 1, node)]
      .filter((item): item is WorkflowStatement => item !== undefined);
    const afterAlternate = new Map(this.environment);
    this.restore(before);
    for (const [name, entry] of afterConsequent) {
      const alternateEntry = afterAlternate.get(name);
      if (alternateEntry && typeName(entry.type) === typeName(alternateEntry.type)) {
        this.environment.set(name, entry);
      }
    }
    return {
      kind: "if",
      condition: condition ?? trueCondition(node),
      consequent,
      alternate,
      from: node.from,
      to: node.to
    };
  }

  /** Splits `if`/`elif`/`else` into one branch per condition plus a final
   * unconditional `else`, so an `elif` chain keeps every condition instead of
   * collapsing into the first body. */
  private ifBranches(node: SyntaxNode): { condition?: SyntaxNode; body: SyntaxNode }[] | undefined {
    const parts = children(node);
    const branches: { condition?: SyntaxNode; body: SyntaxNode }[] = [];
    let index = 0;
    while (index < parts.length) {
      const part = parts[index]!;
      if (part.name === "if" || part.name === "elif") {
        const condition = parts[index + 1];
        const body = parts[index + 2];
        if (!condition || body?.name !== "Body") return undefined;
        branches.push({ condition, body });
        index += 3;
        continue;
      }
      if (part.name === "else") {
        const body = parts[index + 1];
        if (body?.name !== "Body") return undefined;
        branches.push({ body });
        index += 2;
        continue;
      }
      index += 1;
    }
    return branches.length ? branches : undefined;
  }

  private compileWhile(node: SyntaxNode): WorkflowStatement | undefined {
    const parts = children(node);
    const keyword = parts.findIndex((child) => child.name === "while");
    const conditionNode = keyword >= 0 ? parts[keyword + 1] : undefined;
    const bodyNode = parts.find((child) => child.name === "Body");
    if (!conditionNode || !bodyNode) {
      this.error("A while statement requires a condition and body.", node.from, node.to);
      return undefined;
    }
    const condition = this.compileCondition(conditionNode);
    if (!condition) return undefined;
    const before = new Map(this.environment);
    const body = this.compileStatements(bodyNode);
    this.restore(before);
    return { kind: "while", condition, body, from: node.from, to: node.to };
  }

  /** `try`/`except` replaces the all-or-nothing default: a failing step hands
   * control to the handler instead of skipping everything downstream. Nothing a
   * block assigns escapes it, since whether the block ran at all is only known
   * once the workflow runs. */
  private compileTry(node: SyntaxNode): WorkflowStatement | undefined {
    const parts = children(node);
    const bodies = parts.filter((child) => child.name === "Body");
    const exceptIndex = parts.findIndex((child) => child.name === "except");
    const finallyIndex = parts.findIndex((child) => child.name === "finally");
    if (parts.some((child) => child.name === "else")) {
      this.error("try in Dext workflows takes except and finally but not else.", node.from, node.to);
      return undefined;
    }
    if (parts.filter((child) => child.name === "except").length > 1) {
      this.error("A Dext try statement takes a single except block.", node.from, node.to);
      return undefined;
    }
    if (exceptIndex < 0 || !bodies[0] || !bodies[1]) {
      this.error("A try statement requires a body and an except block.", node.from, node.to);
      return undefined;
    }
    // A named exception type would suggest Dext filters on it, which it does
    // not: there is one failure channel and the handler catches all of it.
    const caught = parts[exceptIndex + 1];
    if (caught?.name === "VariableName" && text(this.source, caught) !== "Exception") {
      this.error(
        "Dext try catches every failure. Write 'except:' or 'except Exception as name:'.",
        caught.from,
        caught.to
      );
      return undefined;
    }
    const asIndex = parts.findIndex((child) => child.name === "as");
    const errorNode = asIndex > exceptIndex ? parts[asIndex + 1] : undefined;
    if (asIndex > exceptIndex && errorNode?.name !== "VariableName") {
      this.error("except ... as requires a variable name.", node.from, node.to);
      return undefined;
    }
    const finalizerBody = finallyIndex >= 0
      ? parts.slice(finallyIndex + 1).find((child) => child.name === "Body")
      : undefined;
    const before = new Map(this.environment);
    const body = this.compileStatements(bodies[0]);
    this.restore(before);
    if (errorNode) {
      // The message is the only thing the handler learns about the failure, and
      // it is a plain string so it can be printed or passed along.
      this.environment.set(text(this.source, errorNode), { type: { kind: "string" }, from: errorNode.from });
    }
    const handler = this.compileStatements(bodies[1]);
    this.restore(before);
    const finalizer = finalizerBody ? this.compileStatements(finalizerBody) : [];
    this.restore(before);
    return {
      kind: "try",
      body,
      handler,
      ...(errorNode ? { error: text(this.source, errorNode) } : {}),
      finalizer,
      from: node.from,
      to: node.to
    };
  }

  private restore(snapshot: ReadonlyMap<string, EnvironmentEntry>): void {
    this.environment.clear();
    for (const entry of snapshot) this.environment.set(...entry);
  }

  /** A loop reads a list and runs its body once per item. The loop variable only
   * exists inside the body, and nothing the body assigns escapes it, because the
   * number of passes is not known until the workflow runs. */
  private compileFor(node: SyntaxNode): WorkflowStatement | undefined {
    const parts = children(node);
    const variable = parts.find((child) => child.name === "VariableName");
    const inIndex = parts.findIndex((child) => child.name === "in");
    const iterableNode = inIndex >= 0
      ? parts.slice(inIndex + 1).find((child) => child.name !== "Body" && child.name !== ":" && child.name !== "Comment")
      : undefined;
    const body = parts.find((child) => child.name === "Body");
    if (!variable || !iterableNode || !body) {
      this.error("A for statement requires 'for name in list:' and a body.", node.from, node.to);
      return undefined;
    }
    // `for` and the loop variable are the only nodes allowed before `in`, so
    // anything else means a destructuring form Dext does not support.
    if (inIndex !== 2) {
      this.error("A for statement takes exactly one loop variable.", node.from, node.to);
      return undefined;
    }
    const name = this.source.slice(variable.from, variable.to);
    const iterable = this.compileExpression(iterableNode);
    if (!iterable) return undefined;
    if (iterable.type.kind !== "list" && iterable.type.kind !== "unknown") {
      this.error(`for requires a list but ${typeName(iterable.type)} was given.`, iterableNode.from, iterableNode.to);
      return undefined;
    }
    const before = new Map(this.environment);
    this.environment.set(name, {
      type: iterable.type.kind === "list" ? iterable.type.item : { kind: "unknown" },
      from: variable.from
    });
    const statements = this.compileStatements(body);
    this.restore(before);
    return {
      kind: "for",
      variable: name,
      iterable: iterable.expression,
      body: statements,
      from: node.from,
      to: node.to
    };
  }

  /** Conditions support comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`,
   * `not in`), `and`/`or`/`not`, and any boolean expression. */
  private compileCondition(node: SyntaxNode): WorkflowCondition | undefined {
    const inner = this.unwrap(node);
    if (inner.name === "UnaryExpression") {
      const parts = children(inner);
      const operator = parts.find((child) => child.name === "not");
      const valueNode = parts.find((child) => child.name !== "not");
      if (operator && valueNode) {
        const value = this.compileCondition(valueNode);
        return value ? { kind: "not", value, from: inner.from, to: inner.to } : undefined;
      }
    }
    if (inner.name === "BinaryExpression") {
      const operator = this.binaryOperator(inner);
      if (operator === "and" || operator === "or") {
        const operands = this.binaryOperands(inner);
        if (!operands) return undefined;
        const values: WorkflowCondition[] = [];
        for (const operand of operands) {
          if (operand.node.name === "BinaryExpression" && this.binaryOperator(operand.node) === operator) {
            // `a and b and c` parses left-nested; flatten it into one condition.
            const nested = this.compileCondition(operand.node);
            if (!nested) return undefined;
            values.push(...(nested.kind === "logic" && nested.operator === operator ? nested.values : [nested]));
            continue;
          }
          const compiled = this.compileCondition(operand.node);
          if (!compiled) return undefined;
          values.push(compiled);
        }
        return { kind: "logic", operator, values, from: inner.from, to: inner.to };
      }
      if (operator && isCompareOperator(operator)) {
        const operands = this.binaryOperands(inner);
        if (this.chainedComparison(inner) || !operands || operands.length !== 2) {
          if (this.chainedComparison(inner)) {
            this.error("Dext does not chain comparisons; write 'a < b and b < c'.", inner.from, inner.to);
          } else {
            this.error("A Dext condition compares exactly two values.", inner.from, inner.to);
          }
          return undefined;
        }
        const left = this.compileExpression(operands[0]!);
        const right = this.compileExpression(operands[1]!);
        if (!left || !right) return undefined;
        this.validateComparison(operator, left, right, inner);
        return {
          kind: "comparison",
          operator,
          left: left.expression,
          right: right.expression,
          from: inner.from,
          to: inner.to
        };
      }
      if (operator) {
        // Another operator (`+`, `*`, ...) still compiles; the boolean check
        // below reports that the condition itself is not a condition.
        const value = this.compileExpression(inner);
        if (!value) return undefined;
        if (value.type.kind !== "boolean" && value.type.kind !== "unknown") {
          this.error("An if condition must be boolean.", inner.from, inner.to);
        }
        return { kind: "boolean", value: value.expression, from: inner.from, to: inner.to };
      }
    }
    const value = this.compileExpression(inner);
    if (!value) return undefined;
    if (value.type.kind !== "boolean" && value.type.kind !== "unknown") {
      this.error(
        `An if condition must be boolean, not ${typeName(value.type)}. Compare it or wrap it with bool(value).`,
        inner.from,
        inner.to
      );
    }
    return { kind: "boolean", value: value.expression, from: inner.from, to: inner.to };
  }

  /** Type checks shared by conditions and comparison expressions. */
  private validateComparison(
    operator: CompareOperator,
    left: { expression: WorkflowExpression; type: ValueType },
    right: { expression: WorkflowExpression; type: ValueType },
    node: SyntaxNode
  ): void {
    if (operator === "in" || operator === "not in") {
      const container = right.type;
      if (container.kind === "string" || container.kind === "object" || container.kind === "unknown") return;
      if (container.kind === "list") {
        const item = container.item;
        if (item.kind === "unknown" || left.type.kind === "unknown" || typesOverlap(item, left.type)) return;
        this.error(
          `${typeName(left.type)} is never found in a ${typeName(container)}.`,
          left.expression.from,
          left.expression.to
        );
        return;
      }
      this.error(`'in' needs a string, list, or dictionary on the right, not ${typeName(container)}.`, node.from, node.to);
      return;
    }
    if (!typesOverlap(left.type, right.type)) {
      this.error(
        `Cannot compare ${typeName(left.type)} with ${typeName(right.type)}.`,
        right.expression.from,
        right.expression.to
      );
      return;
    }
    if (["<", "<=", ">", ">="].includes(operator)) {
      const kind = left.type.kind;
      if (kind !== "number" && kind !== "string" && kind !== "unknown") {
        this.error(`Cannot order ${typeName(left.type)} values; only strings and numbers are orderable.`, node.from, node.to);
        return;
      }
    }
    validateStringLiteralComparison(left.type, right.expression, this.diagnostics);
    validateStringLiteralComparison(right.type, left.expression, this.diagnostics);
  }

  private unwrap(node: SyntaxNode): SyntaxNode {
    if (node.name !== "ParenthesizedExpression") return node;
    const inner = children(node).find((child) => child.name !== "(" && child.name !== ")");
    return inner ? this.unwrap(inner) : node;
  }

  /** The operator of a binary expression, or undefined when it holds none. */
  private binaryOperator(node: SyntaxNode): CompareOperator | ArithmeticOperator | LogicalOperator | undefined {
    const operator = children(node)
      .filter((child) => ["ArithOp", "CompareOp", "in", "not", "and", "or"].includes(child.name))
      .map((child) => text(this.source, child))
      .join(" ");
    return operator ? operator as CompareOperator | ArithmeticOperator | LogicalOperator : undefined;
  }

  private binaryOperands(node: SyntaxNode): SyntaxNode[] | undefined {
    const operands = children(node).filter((child) =>
      !["Comment", "(", ")", "ArithOp", "CompareOp", "in", "and", "or"].includes(child.name)
      && !(child.name === "not")
    );
    return operands.length ? operands : undefined;
  }

  /** `a < b < c` parses as a nested binary expression, but means a chained
   * comparison Python evaluates pairwise. Dext rejects it instead of quietly
   * comparing a boolean with `c`. */
  private chainedComparison(node: SyntaxNode): boolean {
    const operator = this.binaryOperator(node);
    if (!operator || !isCompareOperator(operator)) return false;
    const left = children(node)[0];
    if (left?.name !== "BinaryExpression") return false;
    const inner = this.binaryOperator(left);
    return inner !== undefined && isCompareOperator(inner);
  }

  private compileCall(node: SyntaxNode): { call: WorkflowCall; type: ValueType } | undefined {
    const parts = namedChildren(node);
    const callee = parts[0];
    const args = parts.find((child) => child.name === "ArgList");
    if (!callee || !args) {
      this.error("Invalid API call.", node.from, node.to);
      return undefined;
    }
    const pure = this.compilePureCall(callee, args, node);
    if (pure === null) return undefined;
    if (pure) {
      this.error("Only Dext API calls may be used as expression statements.", node.from, node.to);
      return undefined;
    }
    const rawMethod = memberPath(this.source, callee);
    const method = rawMethod ? resolveAlias(rawMethod, this.options.aliases) : undefined;
    if (!method) {
      this.error("Invalid API call.", node.from, node.to);
      return undefined;
    }
    const definition = this.registry.get(method);
    if (!definition) {
      this.error(`Unknown Dext API '${method}'.`, callee?.from ?? node.from, callee?.to ?? node.to, "dext/unknown-api");
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
    // Resolve a literal CLI before checking model, even if cli comes last.
    const cliIndex = parts.findIndex((part, index) => text(this.source, part) === "cli" && parts[index + 1]?.name === "AssignOp");
    const cliValue = cliIndex >= 0 ? parts[cliIndex + 2] : undefined;
    if (cliValue) definition = specializeBuiltinCli(definition, /^["'](codex|claude)["']$/.exec(text(this.source, cliValue))?.[1]);
    const values: WorkflowCall["arguments"] = [];
    const seen = new Set<string>();
    const namedIndexes = new Set<number>();
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
      namedIndexes.add(index);
      namedIndexes.add(index + 1);
      namedIndexes.add(index + 2);
      const compiled = this.compileExpression(valueNode);
      if (compiled) {
        if (definition.id === "ui.form" && name === "fields") {
          if (containsUiCall(compiled.expression)) this.error("Form fields must be declarative data, not UI API calls.", valueNode.from, valueNode.to);
          const data = this.safeConstantValue(compiled.expression);
          if (data !== undefined) {
            try { parseUiForm({ title: "Form", fields: data }); }
            catch (error) { this.error(error instanceof Error ? error.message : "Invalid form fields.", valueNode.from, valueNode.to); }
          }
        }
        const coerced = this.coerceContextValue(compiled, field);
        if (!matchesField(coerced.type, field)) {
          this.error(`Argument '${name}' expects ${fieldTypeName(field)}, not ${typeName(coerced.type)}.`, valueNode.from, valueNode.to);
        }
        if (CLI_BUILTIN_IDS.has(definition.id) && (name === "cli" || name === "model")) {
          this.validateCliLiteral(coerced.expression, field, name);
        }
        values.push({ name, value: coerced.expression, from: nameNode.from, to: valueNode.to });
      }
      index += 2;
    }

    // `print` is convenient for piping a whole result through Output, so also
    // accept its common positional form (`print(result)`). Other Dext APIs
    // remain keyword-only to keep workflow calls unambiguous.
    const positional = parts.filter((part, index) =>
      !namedIndexes.has(index) && !["(", ")", ",", "AssignOp"].includes(part.name)
    );
    const positionalPrint = definition.id === "print" && !seen.has("text") && positional.length === 1;
    if (positionalPrint) {
      const valueNode = positional[0]!;
      const field = definition.input.find((candidate) => candidate.name === "text");
      const compiled = this.compileExpression(valueNode);
      if (field && compiled) {
        const coerced = this.coerceContextValue(compiled, field);
        if (!matchesField(coerced.type, field)) {
          this.error(`Argument 'text' expects ${fieldTypeName(field)}, not ${typeName(coerced.type)}.`, valueNode.from, valueNode.to);
        }
        values.push({ name: "text", value: coerced.expression, from: valueNode.from, to: valueNode.to });
        seen.add("text");
      }
    }
    for (const field of definition.input) {
      if (field.required && field.default === undefined && !seen.has(field.name)) {
        this.error(`Missing required argument '${field.name}'.`, node.from, node.to);
      }
    }
    if (positional.length && !positionalPrint) {
      this.error("Dext API calls require keyword arguments.", positional[0]!.from, positional[0]!.to);
    }
    return values;
  }

  private validateCliLiteral(expression: WorkflowExpression, field: FieldDefinition, path: string): void {
    if (expression.kind === "literal" && field.type === "enum" && !field.values?.includes(String(expression.value))) {
      this.error(`${path} must be one of ${field.values?.join(", ")}.`, expression.from, expression.to);
    }
    if (expression.kind !== "object" || !field.properties) return;
    for (const property of field.properties) {
      if (property.required && !expression.entries.some((entry) => entry.key === property.name)) {
        this.error(`Missing required option '${path}.${property.name}'.`, expression.from, expression.to);
      }
    }
    for (const entry of expression.entries) {
      const property = field.properties.find((candidate) => candidate.name === entry.key);
      if (!property) this.error(`Unknown option '${path}.${entry.key}'.`, entry.from, entry.to);
      else this.validateCliLiteral(entry.value, property, `${path}.${entry.key}`);
    }
  }

  private coerceContextValue(
    compiled: { expression: WorkflowExpression; type: ValueType },
    field: FieldDefinition
  ): { expression: WorkflowExpression; type: ValueType } {
    if (field.multiple) {
      if (compiled.expression.kind !== "list") return compiled;
      const itemTarget = field.type === "context" || field.type === "dir" ? field.type : undefined;
      if (!itemTarget) return compiled;
      const values = compiled.expression.values.map((entry) =>
        entry.kind === "literal" && typeof entry.value === "string"
          ? this.referenceExpression(entry.value, itemTarget, entry.from, entry.to)
          : entry
      );
      return {
        expression: { ...compiled.expression, values },
        type: { kind: "list", item: { kind: itemTarget } }
      };
    }
    if (field.type === "object" && compiled.expression.kind === "object") {
      return {
        expression: this.coerceReferenceTokens(compiled.expression),
        type: compiled.type
      };
    }
    if (field.type !== "context" && field.type !== "dir") return compiled;
    if (compiled.expression.kind === "literal" && typeof compiled.expression.value === "string") {
      return {
        expression: this.referenceExpression(compiled.expression.value, field.type, compiled.expression.from, compiled.expression.to),
        type: { kind: field.type }
      };
    }
    return compiled;
  }

  /** Converts @token string literals nested inside object/list values into
   * typed references so structured arguments (e.g. MCP input) keep resolving
   * attachments the way the removed ref.* expressions did. */
  private coerceReferenceTokens(expression: WorkflowExpression): WorkflowExpression {
    if (expression.kind === "literal" && typeof expression.value === "string") {
      const value = expression.value;
      if (!value.startsWith("@")) return expression;
      return this.referenceExpression(
        value,
        value.endsWith("/") ? "dir" : "context",
        expression.from,
        expression.to
      );
    }
    if (expression.kind === "list") {
      return {
        ...expression,
        values: expression.values.map((entry) => this.coerceReferenceTokens(entry))
      };
    }
    if (expression.kind === "object") {
      return {
        ...expression,
        entries: expression.entries.map((entry) => ({ ...entry, value: this.coerceReferenceTokens(entry.value) }))
      };
    }
    return expression;
  }

  private referenceExpression(
    value: string,
    target: "context" | "dir",
    from: number,
    to: number
  ): WorkflowExpression {
    const reference: ContextReference | DirectoryReference = target === "dir"
      ? { kind: "dir", path: value.replace(/^@/, "").replace(/\/+$/, "") }
      : contextReferenceFromToken(value);
    return { kind: "reference", reference, from, to };
  }

  /** `[body for name in list]` produces one value per item with no way for the
   * items to see one another, so it is the one place Dext can safely fan out.
   * Only a single `for` clause is accepted, and no `if` filter, because a filter
   * would make the result length unknown before the run. */
  private compileComprehension(node: SyntaxNode): { expression: WorkflowExpression; type: ValueType } | undefined {
    const parts = children(node).filter((child) => child.name !== "Comment");
    const forIndex = parts.findIndex((child) => child.name === "for");
    const inIndex = parts.findIndex((child) => child.name === "in");
    const bodyNode = parts.slice(1, forIndex).find((child) => child.name !== "[");
    const variable = parts[forIndex + 1];
    const iterableNode = parts.slice(inIndex + 1).find((child) => child.name !== "]");
    if (forIndex < 0 || inIndex !== forIndex + 2 || !bodyNode || variable?.name !== "VariableName" || !iterableNode) {
      this.error("A comprehension must read '[call(...) for name in list]'.", node.from, node.to);
      return undefined;
    }
    if (parts.filter((child) => child.name === "for").length > 1 || parts.some((child) => child.name === "if")) {
      this.error("A comprehension takes exactly one 'for' clause and no 'if' filter.", node.from, node.to);
      return undefined;
    }
    const iterable = this.compileExpression(iterableNode);
    if (!iterable) return undefined;
    if (iterable.type.kind !== "list" && iterable.type.kind !== "unknown") {
      this.error(
        `A comprehension requires a list but ${typeName(iterable.type)} was given.`,
        iterableNode.from,
        iterableNode.to
      );
      return undefined;
    }
    const name = text(this.source, variable);
    const before = new Map(this.environment);
    this.environment.set(name, {
      type: iterable.type.kind === "list" ? iterable.type.item : { kind: "unknown" },
      from: variable.from
    });
    // A call is the whole point of a comprehension, so it is compiled directly
    // rather than going through the nested-call gate that keeps calls out of
    // ordinary expressions.
    const body = bodyNode.name === "CallExpression"
      ? this.compileCallAsExpression(bodyNode)
      : this.compileExpression(bodyNode);
    this.restore(before);
    if (!body) return undefined;
    return {
      expression: {
        kind: "comprehension",
        variable: name,
        iterable: iterable.expression,
        body: body.expression,
        from: node.from,
        to: node.to
      },
      type: { kind: "list", item: body.type }
    };
  }

  private compileExpression(node: SyntaxNode): Compiled | undefined {
    const compiled = this.compileExpressionNode(node);
    return compiled ? this.foldConstant(compiled) : undefined;
  }

  /** A list literal or a tuple literal. Dext has one sequence type, so a tuple
   * `(a, b)` — and the bare `a, b` form — is a list written the Python way. The
   * item type is the shared type of the entries, or unknown when they differ. */
  private compileSequence(nodes: readonly SyntaxNode[], node: SyntaxNode): Compiled | undefined {
    const compiled: Compiled[] = [];
    for (const child of nodes) {
      const value = this.compileExpression(child);
      if (!value) return undefined;
      compiled.push(value);
    }
    return {
      expression: { kind: "list", values: compiled.map((value) => value.expression), from: node.from, to: node.to },
      type: { kind: "list", item: sequenceItemType(compiled) }
    };
  }

  private compileExpressionNode(node: SyntaxNode): Compiled | undefined {
    if (node.name === "ParenthesizedExpression") {
      const inner = children(node).find((child) => child.name !== "(" && child.name !== ")");
      return inner ? this.compileExpression(inner) : undefined;
    }
    if (node.name === "String") {
      const raw = text(this.source, node);
      const literal = parseStringLiteral(raw);
      if (!literal) {
        this.error("Invalid string literal.", node.from, node.to);
        return undefined;
      }
      if (literal.bytes) {
        this.error("Bytes literals are not supported in Dext workflows.", node.from, node.to);
        return undefined;
      }
      if (literal.formatted) return this.compileFormatString(node);
      return {
        expression: { kind: "literal", value: decodeStringBody(literal.body, literal.raw), from: node.from, to: node.to },
        type: { kind: "string" }
      };
    }
    if (node.name === "FormatString") return this.compileFormatString(node);
    if (node.name === "ContinuedString") return this.compileContinuedString(node);
    if (node.name === "Number") {
      const value = numberLiteral(text(this.source, node));
      if (Number.isNaN(value)) {
        this.error(`Invalid number literal '${text(this.source, node)}'.`, node.from, node.to);
        return undefined;
      }
      return {
        expression: { kind: "literal", value, from: node.from, to: node.to },
        type: { kind: "number" }
      };
    }
    if (node.name === "Boolean") {
      return {
        expression: { kind: "literal", value: text(this.source, node) === "True", from: node.from, to: node.to },
        type: { kind: "boolean" }
      };
    }
    if (node.name === "ArrayExpression") return this.compileSequence(namedChildren(node), node);
    if (node.name === "TupleExpression") return this.compileSequence(namedChildren(node), node);
    if (node.name === "ArrayComprehensionExpression") return this.compileComprehension(node);
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
        const name = decodeStringLiteral(text(this.source, key));
        if (name === undefined) {
          this.error("Dext dictionary keys must be plain strings.", key.from, key.to);
          continue;
        }
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
        // `ref.*` was removed in favour of readable @path tokens, so a stale
        // reference gets the replacement instead of a bare unknown name.
        this.error(
          name === "ref"
            ? "Unknown variable 'ref'. Write file and selection references as @path tokens."
            : `Unknown variable '${name}'.`,
          node.from,
          node.to
        );
        return undefined;
      }
      if (entry.value) {
        return { expression: entry.value, type: entry.type };
      }
      return { expression: { kind: "variable", name, from: node.from, to: node.to }, type: entry.type };
    }
    if (node.name === "MemberExpression") return this.compileMemberExpression(node);
    if (node.name === "BinaryExpression") return this.compileBinaryExpression(node);
    if (node.name === "UnaryExpression") return this.compileUnaryExpression(node);
    if (node.name === "TupleExpression") {
      this.error("Dext has no tuples; write a list with [ ] instead.", node.from, node.to);
      return undefined;
    }
    if (node.name === "CallExpression") {
      const parts = namedChildren(node);
      const callee = parts[0];
      const args = parts.find((child) => child.name === "ArgList");
      if (!callee || !args) {
        this.error("Invalid API call.", node.from, node.to);
        return undefined;
      }
      const pure = this.compilePureCall(callee, args, node);
      if (pure === null) return undefined;
      if (pure) return pure;
      const path = memberPath(this.source, callee);
      const method = path ? resolveAlias(path, this.options.aliases) : undefined;
      const definition = method ? this.registry.get(method) : undefined;
      if (!method || !definition) {
        // Point at the callee rather than the whole call so the squiggle covers
        // the unresolved name instead of its argument list.
        this.error(`Unknown Dext API '${path ?? ""}'.`, callee.from, callee.to, "dext/unknown-api");
        return undefined;
      }
      if (!this.options.allowNestedCalls) {
        this.error("Nested API calls are not allowed in this context.", node.from, node.to);
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
    if (node.name === "ComprehensionExpression") {
      // A parenthesized generator looks like a tuple but fans out like `[...]`.
      this.error(
        "Dext comprehensions use square brackets: [call(...) for name in list].",
        node.from,
        node.to
      );
      return undefined;
    }
    this.error(`Expression '${node.name}' is not allowed in Dext workflows.`, node.from, node.to);
    return undefined;
  }

  /** `a.b`, `a[b]`, and slices: `a[1:]`, `a[::-1]`. */
  private compileMemberExpression(node: SyntaxNode): Compiled | undefined {
    const parts = children(node);
    const objectNode = parts[0];
    const object = objectNode ? this.compileExpression(objectNode) : undefined;
    if (!object) return undefined;
    const dot = parts.findIndex((child) => child.name === ".");
    if (dot >= 0) {
      const propertyNode = parts[dot + 1];
      const property = propertyNode ? text(this.source, propertyNode) : "";
      if (object.type.kind !== "result" && object.type.kind !== "object" && object.type.kind !== "unknown") {
        this.error(
          `Cannot read field '${property}' from ${typeName(object.type)}.`,
          node.from,
          node.to
        );
        return undefined;
      }
      const type = object.type.kind === "result" ? (object.type.fields[property] ?? { kind: "unknown" as const }) : { kind: "unknown" as const };
      return { expression: { kind: "member", object: object.expression, property, from: node.from, to: node.to }, type };
    }
    const open = parts.findIndex((child) => child.name === "[");
    if (open < 0) {
      this.error("Invalid member access.", node.from, node.to);
      return undefined;
    }
    const closing = parts.length - 1;
    const colon = parts.findIndex((child, index) => child.name === ":" && index > open && index < closing);
    if (colon >= 0) return this.compileSlice(node, parts, open, closing, object);
    const indexNode = parts[open + 1];
    if (!indexNode) {
      this.error("Invalid member access.", node.from, node.to);
      return undefined;
    }
    const index = this.compileExpression(indexNode);
    if (!index) return undefined;
    if (["number", "boolean", "context", "dir"].includes(object.type.kind)) {
      this.error(`Cannot index ${typeName(object.type)}.`, node.from, node.to);
      return undefined;
    }
    const type = object.type.kind === "string"
      ? { kind: "string" as const }
      : object.type.kind === "list"
        ? object.type.item
        : object.type.kind === "object"
          ? object.type.item ?? { kind: "unknown" as const }
          : { kind: "unknown" as const };
    return { expression: { kind: "index", object: object.expression, index: index.expression, from: node.from, to: node.to }, type };
  }

  private compileSlice(
    node: SyntaxNode,
    parts: readonly SyntaxNode[],
    open: number,
    closing: number,
    object: Compiled
  ): Compiled | undefined {
    if (object.type.kind !== "string" && object.type.kind !== "list" && object.type.kind !== "unknown") {
      this.error(`Cannot slice ${typeName(object.type)}.`, node.from, node.to);
      return undefined;
    }
    const segments: SyntaxNode[][] = [[]];
    for (let index = open + 1; index < closing; index += 1) {
      const part = parts[index]!;
      if (part.name === ":") {
        segments.push([]);
        continue;
      }
      segments.at(-1)!.push(part);
    }
    if (segments.length > 3) {
      this.error("A slice takes at most start, stop, and step.", node.from, node.to);
      return undefined;
    }
    const compiled = segments.map((segment) => segment[0] ? this.compileExpression(segment[0]) : undefined);
    if (compiled.some((value, index) => segments[index]!.length && !value)) return undefined;
    const [start, stop, step] = compiled;
    return {
      expression: {
        kind: "slice",
        object: object.expression,
        ...(start ? { start: start.expression } : {}),
        ...(stop ? { stop: stop.expression } : {}),
        ...(step ? { step: step.expression } : {}),
        from: node.from,
        to: node.to
      },
      type: object.type
    };
  }

  private compileBinaryExpression(node: SyntaxNode): Compiled | undefined {
    if (this.chainedComparison(node)) {
      this.error("Dext does not chain comparisons; write 'a < b and b < c'.", node.from, node.to);
      return undefined;
    }
    const operator = this.binaryOperator(node);
    const operands = this.binaryOperands(node);
    if (!operator || !operands || operands.length !== 2) {
      this.error("Dext supports one operator between two values.", node.from, node.to);
      return undefined;
    }
    const left = this.compileExpression(operands[0]!);
    const right = this.compileExpression(operands[1]!);
    if (!left || !right) return undefined;
    if (operator === "and" || operator === "or") {
      for (const operand of [left, right]) {
        if (operand.type.kind !== "boolean" && operand.type.kind !== "unknown") {
          this.error(
            `'${operator}' needs boolean values; use bool(value) to convert ${typeName(operand.type)}.`,
            operand.expression.from,
            operand.expression.to
          );
        }
      }
      const values: WorkflowExpression[] = [];
      for (const operand of [left, right]) {
        // `a and b and c` parses left-nested, so equal operators flatten into
        // one node and short-circuit together.
        if (operand.expression.kind === "logic" && operand.expression.operator === operator) values.push(...operand.expression.values);
        else values.push(operand.expression);
      }
      return { expression: { kind: "logic", operator, values, from: node.from, to: node.to }, type: { kind: "boolean" } };
    }
    if (isCompareOperator(operator)) {
      this.validateComparison(operator, left, right, node);
      return {
        expression: { kind: "compare", operator, left: left.expression, right: right.expression, from: node.from, to: node.to },
        type: { kind: "boolean" }
      };
    }
    const type = this.arithmeticType(operator, left, right, node);
    return {
      expression: { kind: "binary", operator, left: left.expression, right: right.expression, from: node.from, to: node.to },
      type
    };
  }

  /** `+` concatenates strings and adds numbers, `*` repeats strings and
   * multiplies numbers, and `%` formats a string or takes a remainder. */
  private arithmeticType(
    operator: ArithmeticOperator,
    left: Compiled,
    right: Compiled,
    node: SyntaxNode
  ): ValueType {
    const leftKind = left.type.kind;
    const rightKind = right.type.kind;
    const unknown = leftKind === "unknown" || rightKind === "unknown";
    if (operator === "+" && (leftKind === "string" || rightKind === "string") && !unknown) {
      if (leftKind === "string" && rightKind === "string") return { kind: "string" };
      const textSide = leftKind === "string" ? left : right;
      const other = leftKind === "string" ? right : left;
      this.error(
        `Cannot add ${typeName(textSide.type)} and ${typeName(other.type)}. Use an f-string (f"{value}") or str(value) to build text.`,
        node.from,
        node.to
      );
      return { kind: "string" };
    }
    if (operator === "*" && (leftKind === "string" || rightKind === "string") && !unknown) {
      const count = leftKind === "string" ? right : left;
      if (count.type.kind !== "number") {
        this.error(`A string can only be repeated a number of times, not ${typeName(count.type)}.`, node.from, node.to);
      }
      return { kind: "string" };
    }
    if (operator === "%" && leftKind === "string") return { kind: "string" };
    if (!unknown && (leftKind !== "number" || rightKind !== "number")) {
      this.error(
        `'${operator}' needs numbers, not ${typeName(left.type)} and ${typeName(right.type)}.`,
        node.from,
        node.to
      );
    }
    return { kind: "number" };
  }

  private compileUnaryExpression(node: SyntaxNode): Compiled | undefined {
    const parts = children(node);
    const operatorNode = parts.find((child) => child.name === "ArithOp" || child.name === "not");
    const valueNode = parts.find((child) => child !== operatorNode && child.name !== "Comment");
    if (!operatorNode || !valueNode) {
      this.error("Unsupported unary expression.", node.from, node.to);
      return undefined;
    }
    const operator = text(this.source, operatorNode);
    const value = this.compileExpression(valueNode);
    if (!value) return undefined;
    if (operator === "not") {
      if (value.type.kind !== "boolean" && value.type.kind !== "unknown") {
        this.error(`'not' needs a boolean value; use bool(value) to convert ${typeName(value.type)}.`, node.from, node.to);
      }
      return { expression: { kind: "unary", operator: "not", value: value.expression, from: node.from, to: node.to }, type: { kind: "boolean" } };
    }
    if (operator !== "-" && operator !== "+") {
      this.error(`Unary '${operator}' is not allowed in Dext workflows.`, node.from, node.to);
      return undefined;
    }
    if (value.type.kind !== "number" && value.type.kind !== "unknown") {
      this.error(`Unary '${operator}' needs a number, not ${typeName(value.type)}.`, node.from, node.to);
    }
    return { expression: { kind: "unary", operator, value: value.expression, from: node.from, to: node.to }, type: { kind: "number" } };
  }

  /** `f"...{value!r:>10}..."`. Text between replacement fields is decoded here
   * because the grammar only reports the fields, not the literal runs. */
  private compileFormatString(node: SyntaxNode): Compiled | undefined {
    const raw = text(this.source, node);
    const literal = parseStringLiteral(raw);
    if (!literal) {
      this.error("Invalid f-string.", node.from, node.to);
      return undefined;
    }
    if (literal.bytes) {
      this.error("Bytes literals are not supported in Dext workflows.", node.from, node.to);
      return undefined;
    }
    const bodyStart = node.from + literal.prefix.length + literal.quote.length;
    const bodyEnd = node.to - literal.quote.length;
    const parts: WorkflowFormatPart[] = [];
    let cursor = bodyStart;
    for (const child of children(node)) {
      if (child.name !== "FormatReplacement") continue;
      if (child.from > cursor) parts.push({ kind: "text", text: decodeFormatText(this.source.slice(cursor, child.from), literal.raw) });
      const replacement = this.compileFormatReplacement(child, literal.raw);
      if (!replacement) return undefined;
      parts.push(...replacement);
      cursor = child.to;
    }
    if (cursor < bodyEnd) parts.push({ kind: "text", text: decodeFormatText(this.source.slice(cursor, bodyEnd), literal.raw) });
    return { expression: { kind: "format", parts: mergeTextParts(parts), from: node.from, to: node.to }, type: { kind: "string" } };
  }

  private compileFormatReplacement(node: SyntaxNode, raw: boolean): WorkflowFormatPart[] | undefined {
    const parts = children(node);
    const expressionNode = parts.find((child) =>
      !["{", "}", "FormatConversion", "FormatSpec", "FormatSelfDoc", "Comment"].includes(child.name)
    );
    if (!expressionNode) {
      this.error("An f-string replacement must contain a value.", node.from, node.to);
      return undefined;
    }
    const compiled = this.compileExpression(expressionNode);
    if (!compiled) return undefined;
    const conversionNode = parts.find((child) => child.name === "FormatConversion");
    const specNode = parts.find((child) => child.name === "FormatSpec");
    const selfDoc = parts.find((child) => child.name === "FormatSelfDoc");
    let conversion = conversionNode
      ? text(this.source, conversionNode).replace(/^!/, "") as FormatConversion
      : undefined;
    if (conversion !== undefined && !["s", "r", "a"].includes(conversion)) {
      this.error(`Unknown f-string conversion '!${conversion}'.`, conversionNode!.from, conversionNode!.to);
      return undefined;
    }
    let spec = "";
    let specParts: WorkflowFormatPart[] | undefined;
    if (specNode) {
      const nested = children(specNode).filter((child) => child.name === "FormatReplacement");
      if (nested.length) {
        const built: WorkflowFormatPart[] = [];
        let cursor = specNode.from + 1;
        for (const child of nested) {
          if (child.from > cursor) built.push({ kind: "text", text: this.source.slice(cursor, child.from) });
          const replacement = this.compileFormatReplacement(child, raw);
          if (!replacement) return undefined;
          built.push(...replacement);
          cursor = child.to;
        }
        if (cursor < specNode.to) built.push({ kind: "text", text: this.source.slice(cursor, specNode.to) });
        specParts = mergeTextParts(built);
      } else {
        spec = this.source.slice(specNode.from + 1, specNode.to);
      }
    }
    // `f"{value=}"` prints the source text of the field and repr()s the value,
    // unless a format spec asks for something else.
    if (selfDoc && !conversion && !specNode) conversion = "r";
    const result: WorkflowFormatPart[] = [];
    if (selfDoc) result.push({ kind: "text", text: this.source.slice(node.from + 1, selfDoc.to) });
    result.push({
      kind: "expression",
      expression: compiled.expression,
      ...(conversion ? { conversion } : {}),
      ...(specParts ? { specParts } : { spec })
    });
    return result;
  }

  /** Adjacent literals (`"a" f"{b}"`) concatenate in Python, so they compile to
   * one text value. */
  private compileContinuedString(node: SyntaxNode): Compiled | undefined {
    const parts: WorkflowFormatPart[] = [];
    for (const child of children(node)) {
      if (child.name === "Comment") continue;
      const compiled = this.compileExpression(child);
      if (!compiled) return undefined;
      if (compiled.expression.kind === "literal" && typeof compiled.expression.value === "string") {
        parts.push({ kind: "text", text: compiled.expression.value });
        continue;
      }
      if (compiled.expression.kind === "format") {
        parts.push(...compiled.expression.parts);
        continue;
      }
      this.error("Only strings can be written next to each other.", child.from, child.to);
      return undefined;
    }
    return { expression: { kind: "format", parts: mergeTextParts(parts), from: node.from, to: node.to }, type: { kind: "string" } };
  }

  /** Pure helpers (`len`, `str`, `range`) and string methods (`text.upper()`)
   * compile without an API call. Returns undefined when the callee is not one of
   * them, and null when it is one but did not compile. */
  private compilePureCall(callee: SyntaxNode, args: SyntaxNode, node: SyntaxNode): Compiled | null | undefined {
    if (callee.name === "VariableName") {
      const name = text(this.source, callee);
      if (this.registry.get(name)) return undefined;
      const signature = PURE_FUNCTIONS[name];
      if (!signature) return undefined;
      return this.compileFunctionCall(name, signature, args, node) ?? null;
    }
    if (callee.name !== "MemberExpression") return undefined;
    const parts = children(callee);
    const objectNode = parts[0];
    const methodNode = parts.at(-1);
    if (!objectNode || methodNode?.name !== "PropertyName") return undefined;
    const method = text(this.source, methodNode);
    const path = memberPath(this.source, callee);
    // A registered API id always wins over a same-named helper.
    if (path && this.registry.get(resolveAlias(path, this.options.aliases))) return undefined;
    // `mcp.<server>.<tool>` is only ever an API path. Falling through to the
    // receiver branch below would compile the `mcp` root as a variable and
    // report "Unknown variable 'mcp'"; letting the API path resolve instead
    // names the tool that is actually missing.
    if (path?.startsWith("mcp.")) return undefined;
    const signature = STRING_METHODS[method];
    if (!signature) {
      if (objectNode.name === "VariableName" && !this.environment.has(text(this.source, objectNode))) return undefined;
      const receiver = this.compileExpression(objectNode);
      if (!receiver) return null;
      this.error(
        receiver.type.kind === "string" || receiver.type.kind === "unknown"
          ? `String has no method '${method}'.`
          : `${typeName(receiver.type)} has no method '${method}'.`,
        node.from,
        node.to
      );
      return null;
    }
    if (objectNode.name === "VariableName" && !this.environment.has(text(this.source, objectNode))) return undefined;
    return this.compileMethodCall(objectNode, method, signature, args, node);
  }

  private compileMethodCall(
    receiverNode: SyntaxNode,
    method: string,
    signature: PureSignature,
    args: SyntaxNode,
    node: SyntaxNode
  ): Compiled | null {
    const receiver = this.compileExpression(receiverNode);
    if (!receiver) return null;
    if (receiver.type.kind !== "string" && receiver.type.kind !== "unknown") {
      this.error(
        method === "join" && receiver.type.kind === "list"
          ? "Write separator.join(list) — for example ','.join(items)."
          : `'${method}()' is a string method, but ${typeName(receiver.type)} was given.`,
        node.from,
        node.to
      );
      return null;
    }
    const parsed = this.pureArguments(args, signature, `str.${method}()`);
    if (!parsed) return null;
    if (parsed.values.length < signature.required || parsed.values.length > signature.maximum) {
      this.error(`str.${method}() takes ${arityText(signature)} but ${parsed.values.length} were given.`, node.from, node.to);
      return null;
    }
    if (!this.validateListArgument(parsed, signature, `str.${method}()`, node)) return null;
    return {
      expression: {
        kind: "method",
        receiver: receiver.expression,
        method,
        arguments: parsed.values.map((value, index) => argumentOf(value, signature.parameters?.[index])),
        keywords: parsed.keywords,
        from: node.from,
        to: node.to
      },
      type: pureValueType(signature.returns)
    };
  }

  private compileFunctionCall(
    name: string,
    signature: PureSignature,
    args: SyntaxNode,
    node: SyntaxNode
  ): Compiled | undefined {
    const parsed = this.pureArguments(args, signature, `${name}()`);
    if (!parsed) return undefined;
    if (parsed.values.length < signature.required || parsed.values.length > signature.maximum) {
      this.error(`${name}() takes ${arityText(signature)} but ${parsed.values.length} were given.`, node.from, node.to);
      return undefined;
    }
    if (!this.validateListArgument(parsed, signature, `${name}()`, node)) return undefined;
    const type = name === "min" || name === "max" || name === "sorted" || name === "reversed"
      ? pureElementValueType(parsed.values[0]?.type ?? { kind: "unknown" })
      : pureValueType(signature.returns);
    return {
      expression: {
        kind: "function",
        name,
        arguments: parsed.values.map((value) => value.expression),
        keywords: parsed.keywords,
        from: node.from,
        to: node.to
      },
      type
    };
  }

  private validateListArgument(
    parsed: { values: Compiled[] },
    signature: PureSignature,
    label: string,
    node: SyntaxNode
  ): boolean {
    if (signature.listArgument === undefined) return true;
    const argument = parsed.values[signature.listArgument];
    if (!argument || argument.type.kind === "list" || argument.type.kind === "unknown") return true;
    this.error(`${label} expects a list but ${typeName(argument.type)} was given.`, node.from, node.to);
    return false;
  }

  /** Positional and keyword arguments for a pure helper. Keyword arguments are
   * accepted when the signature names its parameters; they must keep the
   * declared order, because Dext never silently reorders a call. */
  private pureArguments(
    node: SyntaxNode,
    signature: PureSignature,
    label: string
  ): { values: Compiled[]; keywords: { name: string; value: WorkflowExpression; from: number; to: number }[] } | undefined {
    const parts = children(node);
    const values: Compiled[] = [];
    const keywords: { name: string; compiled: Compiled; from: number; to: number }[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (["(", ")", ",", "Comment", "AssignOp"].includes(part.name)) continue;
      if (part.name === "VariableName" && parts[index + 1]?.name === "AssignOp") {
        const valueNode = parts[index + 2];
        if (!valueNode) continue;
        const compiled = this.compileExpression(valueNode);
        if (!compiled) return undefined;
        keywords.push({ name: text(this.source, part), compiled, from: part.from, to: valueNode.to });
        index += 2;
        continue;
      }
      const compiled = this.compileExpression(part);
      if (!compiled) return undefined;
      values.push(compiled);
    }
    const collected: { name: string; value: WorkflowExpression; from: number; to: number }[] = [];
    for (const keyword of keywords) {
      if (signature.keywords) {
        collected.push({ name: keyword.name, value: keyword.compiled.expression, from: keyword.from, to: keyword.to });
        continue;
      }
      const position = (signature.parameters ?? []).indexOf(keyword.name);
      if (position < 0) {
        this.error(`Unknown argument '${keyword.name}' for ${label}.`, keyword.from, keyword.to);
        return undefined;
      }
      if (position !== values.length) {
        this.error(`Argument '${keyword.name}' would have to be reordered; Dext keeps the order you write.`, keyword.from, keyword.to);
        return undefined;
      }
      values.push(keyword.compiled);
    }
    return { values, keywords: collected };
  }

  /** Replaces an expression the compiler can evaluate with its value, so
   * `"a" + "b"` behaves exactly like `"ab"` everywhere, including in
   * compile-time checks such as UI form validation. */
  private foldConstant(compiled: Compiled): Compiled {
    const { expression, type } = compiled;
    if (["literal", "list", "object"].includes(expression.kind)) return compiled;
    if (type.kind !== "string" && type.kind !== "number" && type.kind !== "boolean" && type.kind !== "list") return compiled;
    let constant: { value: unknown } | undefined;
    try {
      constant = this.constantValue(expression);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error), expression.from, expression.to);
      return compiled;
    }
    if (!constant) return compiled;
    const folded = this.literalExpression(constant.value, expression.from, expression.to);
    return folded ? { expression: folded, type } : compiled;
  }

  /** Turns a computed constant back into a literal expression, so the common
   * `"a,b".split(",")` or `sorted([...])` shape stops being a runtime step. */
  private literalExpression(value: unknown, from: number, to: number): WorkflowExpression | undefined {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return { kind: "literal", value, from, to };
    }
    if (Array.isArray(value)) {
      // A huge folded list would bloat the program without helping anyone.
      if (value.length > MAX_FOLDED_ITEMS) return undefined;
      const values: WorkflowExpression[] = [];
      for (const item of value) {
        const folded = this.literalExpression(item, from, to);
        if (!folded) return undefined;
        values.push(folded);
      }
      return { kind: "list", values, from, to };
    }
    if (typeof value === "object" && value !== null) {
      const entries: Extract<WorkflowExpression, { kind: "object" }>["entries"] = [];
      for (const [key, item] of Object.entries(value)) {
        const folded = this.literalExpression(item, from, to);
        if (!folded) return undefined;
        entries.push({ key, value: folded, from, to });
      }
      return { kind: "object", entries, from, to };
    }
    return undefined;
  }

  /** Evaluates an expression that depends on nothing but its own literals.
   * Throws for a genuine Python error such as division by zero. */
  private constantValue(expression: WorkflowExpression): { value: unknown } | undefined {
    switch (expression.kind) {
      case "literal": return { value: expression.value };
      case "list": {
        const values: unknown[] = [];
        for (const item of expression.values) {
          const constant = this.constantValue(item);
          if (!constant) return undefined;
          values.push(constant.value);
        }
        return { value: values };
      }
      case "object": {
        const entries: [string, unknown][] = [];
        for (const entry of expression.entries) {
          const constant = this.constantValue(entry.value);
          if (!constant) return undefined;
          entries.push([entry.key, constant.value]);
        }
        return { value: Object.fromEntries(entries) };
      }
      case "format": {
        const value = this.formatText(expression.parts);
        return value === undefined ? undefined : { value };
      }
      case "binary": {
        const left = this.constantValue(expression.left);
        const right = this.constantValue(expression.right);
        if (!left || !right) return undefined;
        return { value: pythonArithmetic(expression.operator, left.value, right.value) };
      }
      case "unary": {
        const value = this.constantValue(expression.value);
        if (!value) return undefined;
        if (expression.operator === "not") return { value: !pythonTruthy(value.value) };
        const number = typeof value.value === "boolean" ? Number(value.value) : value.value;
        if (typeof number !== "number") throw new Error(`Unary '${expression.operator}' needs a number.`);
        return { value: expression.operator === "-" ? -number : number };
      }
      case "compare": {
        const left = this.constantValue(expression.left);
        const right = this.constantValue(expression.right);
        if (!left || !right) return undefined;
        return { value: pythonCompare(expression.operator, left.value, right.value) };
      }
      case "logic": {
        const values: unknown[] = [];
        for (const item of expression.values) {
          const constant = this.constantValue(item);
          if (!constant) return undefined;
          values.push(constant.value);
        }
        return {
          value: expression.operator === "and"
            ? values.every(pythonTruthy)
            : values.some(pythonTruthy)
        };
      }
      case "slice": {
        const object = this.constantValue(expression.object);
        if (!object) return undefined;
        const parts = [expression.start, expression.stop, expression.step].map((part) => {
          if (!part) return undefined;
          const constant = this.constantValue(part);
          if (!constant) throw new Error("Unsupported slice bound.");
          return constant.value;
        });
        return { value: pythonSlice(object.value, parts[0], parts[1], parts[2]) };
      }
      case "index": {
        const object = this.constantValue(expression.object);
        const index = this.constantValue(expression.index);
        if (!object || !index) return undefined;
        return { value: pythonIndex(object.value, index.value) };
      }
      case "member": {
        const object = this.constantValue(expression.object);
        if (!object || typeof object.value !== "object" || object.value === null) return undefined;
        const value = (object.value as Record<string, unknown>)[expression.property];
        return value === undefined ? undefined : { value };
      }
      case "method": {
        const receiver = this.constantValue(expression.receiver);
        if (!receiver || typeof receiver.value !== "string") return undefined;
        const values = this.constantValues(expression.arguments.map((argument) => argument.value));
        if (!values) return undefined;
        const keywords = this.constantKeywords(expression.keywords);
        if (!keywords) return undefined;
        return { value: stringMethod(receiver.value, expression.method, values, keywords) };
      }
      case "function": {
        const values = this.constantValues(expression.arguments);
        if (!values) return undefined;
        const keywords = this.constantKeywords(expression.keywords);
        if (!keywords) return undefined;
        return { value: pureFunction(expression.name, values, keywords) };
      }
      default: return undefined;
    }
  }

  private constantValues(expressions: readonly WorkflowExpression[]): unknown[] | undefined {
    const values: unknown[] = [];
    for (const expression of expressions) {
      const constant = this.constantValue(expression);
      if (!constant) return undefined;
      values.push(constant.value);
    }
    return values;
  }

  private constantKeywords(
    keywords: readonly { name: string; value: WorkflowExpression }[]
  ): Record<string, unknown> | undefined {
    const values: Record<string, unknown> = {};
    for (const keyword of keywords) {
      const constant = this.constantValue(keyword.value);
      if (!constant) return undefined;
      values[keyword.name] = constant.value;
    }
    return values;
  }

  private formatText(parts: readonly WorkflowFormatPart[]): string | undefined {
    let result = "";
    for (const part of parts) {
      if (part.kind === "text") {
        result += part.text;
        continue;
      }
      const constant = this.constantValue(part.expression);
      if (!constant) return undefined;
      const spec = part.specParts ? this.formatText(part.specParts) : part.spec ?? "";
      if (spec === undefined) return undefined;
      result += formatReplacement(constant.value, part.conversion, spec);
    }
    return result;
  }

  private error(message: string, from: number, to: number, code = "dext/compile"): void {
    this.diagnostics.push({ message, severity: "error", from, to: Math.max(from + 1, to), code });
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

function contextReferenceFromToken(value: string): ContextReference {
  const token = value.startsWith("@") ? value.slice(1) : value;
  if (token === "selection") return { kind: "selection" };
  if (token === "active_file") return { kind: "activeFile" };
  return { kind: "file", path: token };
}

export function fieldType(field: FieldDefinition): ValueType {
  let value: ValueType;
  if (field.type === "enum") value = field.values
    ? { kind: "string", literals: field.values }
    : { kind: "string" };
  else if (field.type === "context") value = { kind: "context" };
  else if (field.type === "dir") value = { kind: "dir" };
  else if (field.type === "object") {
    // MCP schemas can describe object members recursively. Represent a named
    // object as a result-shaped value so member expressions (including loop
    // variables over arrays of objects) retain their fields.
    if (field.properties?.length) {
      const fields: Record<string, ValueType> = {};
      for (const property of field.properties) fields[property.name] = fieldType(property);
      value = result(`${field.name}Result`, fields);
    } else {
      value = { kind: "object" };
    }
  }
  else if (field.type === "list") {
    value = { kind: "list", item: field.items ? fieldType(field.items) : { kind: "unknown" } };
  }
  else if (field.type === "result" && /^Ui(?:Select|Radio|Checkbox|Input|Confirm|Alert|Form)Result$/.test(field.resultType ?? "")) {
    const action = field.resultType!.slice(2, -6).toLowerCase();
    value = result(field.resultType!, Object.fromEntries(uiOutputFields(action).map((property) => [property.name, fieldType(property)])));
  }
  else if (field.type === "result") value = Object.values(RESULT_TYPES).find((type) => type.kind === "result" && type.name === field.resultType) ?? result("Result", {});
  else value = { kind: field.type };
  return field.multiple ? { kind: "list", item: value } : value;
}

export function outputType(definition: CallableDefinition): ValueType {
  if (!definition.output.fields) {
    const match = /^Ui(Select|Radio|Checkbox|Input|Confirm|Alert|Form)Result$/.exec(definition.output.resultType ?? "");
    if (match) return outputType({ ...definition, output: { ...definition.output, fields: uiOutputFields(match[1]!.toLowerCase()) } });
    return RESULT_TYPES[definition.output.kind] ?? { kind: "unknown" };
  }
  const fields: Record<string, ValueType> = {};
  for (const field of definition.output.fields) fields[field.name] = definition.output.resultType === "UiFormResult" && field.name === "answers"
    ? { kind: "object", item: result("UiFieldAnswer", Object.fromEntries((field.properties ?? []).map((property) => [property.name, fieldType(property)]))) }
    : fieldType(field);
  return result(definition.output.resultType ?? `${definition.output.kind}Result`, fields);
}

function matchesField(actual: ValueType, field: FieldDefinition): boolean {
  if (actual.kind === "unknown") return true;
  return [field.type, ...(field.accepts ?? [])].some((type) => {
    if (type === "object" && actual.kind === "object") return true;
    const expected = fieldType({ ...field, type, ...(field.accepts ? { accepts: [] } : {}) });
    if (field.multiple && expected.kind === "list") {
      return actual.kind === expected.item.kind
        || (actual.kind === "list" && (actual.item.kind === expected.item.kind || actual.item.kind === "unknown"));
    }
    return expected.kind === "result"
      ? actual.kind === "result" && (!field.resultType || actual.name === field.resultType)
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

function containsUiCall(expression: WorkflowExpression): boolean {
  const nested = (values: readonly WorkflowExpression[]): boolean => values.some(containsUiCall);
  switch (expression.kind) {
    case "call": return expression.call.method.startsWith("ui.") || expression.call.arguments.some((argument) => containsUiCall(argument.value));
    case "list": return nested(expression.values);
    case "object": return expression.entries.some((entry) => containsUiCall(entry.value));
    case "comprehension": return containsUiCall(expression.body) || containsUiCall(expression.iterable);
    case "format": return expression.parts.some((part) => part.kind === "expression" && (
      containsUiCall(part.expression) || Boolean(part.specParts?.some((nested) => nested.kind === "expression" && containsUiCall(nested.expression)))
    ));
    case "binary": case "compare": return containsUiCall(expression.left) || containsUiCall(expression.right);
    case "unary": return containsUiCall(expression.value);
    case "logic": return nested(expression.values);
    case "method": return containsUiCall(expression.receiver)
      || expression.arguments.some((argument) => containsUiCall(argument.value))
      || expression.keywords.some((keyword) => containsUiCall(keyword.value));
    case "function": return nested(expression.arguments) || expression.keywords.some((keyword) => containsUiCall(keyword.value));
    case "slice": return containsUiCall(expression.object)
      || [expression.start, expression.stop, expression.step].some((part) => part !== undefined && containsUiCall(part));
    case "index": return containsUiCall(expression.object) || containsUiCall(expression.index);
    case "member": return containsUiCall(expression.object);
    default: return false;
  }
}

function isUiResultType(type: ValueType): boolean {
  return type.kind === "result" && /^Ui(?:Select|Radio|Checkbox|Input|Confirm|Alert|Form)?Result$/.test(type.name);
}
