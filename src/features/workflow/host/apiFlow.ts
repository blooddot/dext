import type { Node, Tree } from "web-tree-sitter";
import { parserFor } from "../../../platform/node/syntaxParser.js";
import {
  EMPTY_API_FLOW,
  isApiFlowTag,
  type ApiFlow,
  type ApiFlowApiCall,
  type ApiFlowEdge,
  type ApiFlowEntry,
  type ApiFlowFunction,
  type ApiFlowIssue,
  type ApiFlowStep,
  type ApiFlowStepEdge,
  type ApiFlowStepKind,
  type ApiFlowTag
} from "../contracts/apiFlow.js";

const FUNCTION_TYPES = new Set(["function_declaration", "function_signature", "function_expression", "arrow_function"]);
const CLASS_TYPES = new Set(["class_declaration", "class", "abstract_class_declaration", "class_expression"]);
const LOOP_TYPES = new Set(["while_statement", "do_statement", "for_statement", "for_in_statement"]);
/** The one end node every `return` in the entry function lands on. */
const END_LABEL = "结束";
/** Longer conditions are cut in the diagram only; the Function list keeps the lines. */
const LABEL_MAX = 44;
const WRAPPER_EXAMPLES: Record<ApiFlowTag, string> = {
  ask: "askForPlan",
  agent: "runAgent",
  plan: "planWork",
  skill: "runSkill",
  template: "renderTemplate",
  terminal: "runTerminal"
};

interface PositionedCall {
  index: number;
  line: number;
}

interface LocalCall extends PositionedCall {
  name: string;
}

interface ApiCall extends PositionedCall {
  tag: ApiFlowTag;
  callee: string;
}

interface WorkingFunction {
  name: string;
  line: number;
  exported: boolean;
  body: Node | undefined;
  localCalls: LocalCall[];
  apiCalls: ApiCall[];
}

function unquote(text: string): string {
  return text.replace(/^(['"`])([\s\S]*)\1$/, "$2");
}

function position(node: Node): number {
  return node.startIndex;
}

function bodyOf(node: Node): Node | undefined {
  return FUNCTION_TYPES.has(node.type) && node.type !== "function_signature" ? node.childForFieldName("body") ?? undefined : undefined;
}

/** Named imports, aliased imports and namespace imports of the `dext` module. */
function collectDextImports(root: Node): { tags: Map<string, ApiFlowTag>; namespaces: Set<string> } {
  const tags = new Map<string, ApiFlowTag>();
  const namespaces = new Set<string>();
  const visit = (node: Node): void => {
    if (node.type === "import_specifier") {
      if (node.children.some((child) => child.type === "type")) return;
      const imported = node.childForFieldName("name")?.text;
      const alias = node.childForFieldName("alias")?.text;
      if (imported && isApiFlowTag(imported)) tags.set(alias ?? imported, imported);
      return;
    }
    if (node.type === "namespace_import") {
      const local = node.namedChildren.find((child) => child.type === "identifier")?.text;
      if (local) namespaces.add(local);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  for (const statement of root.namedChildren) {
    if (statement.type !== "import_statement") continue;
    if (statement.children.some((child) => child.type === "type")) continue;
    const source = statement.namedChildren.filter((child) => child.type === "string").at(-1);
    if (!source || unquote(source.text) !== "dext") continue;
    const clause = statement.namedChildren.find((child) => child.type === "import_clause");
    if (clause) visit(clause);
  }
  return { tags, namespaces };
}

/**
 * Reads every function a module can call by name: declarations (overloads merged
 * into one node), variable-bound arrows and function expressions, and default
 * exports. The implementation body, when present, wins over signatures.
 */
function collectFunctions(root: Node): { functions: Map<string, WorkingFunction>; duplicates: Set<string> } {
  const functions = new Map<string, WorkingFunction>();
  const duplicates = new Set<string>();
  const defaultLocals: string[] = [];
  const exportAliases: Array<{ local: string; alias: string }> = [];

  const add = (name: string, node: Node, exported: boolean): void => {
    const body = bodyOf(node);
    const existing = functions.get(name);
    if (!existing) {
      functions.set(name, {
        name,
        line: body ? node.startPosition.row + 1 : node.startPosition.row + 1,
        exported,
        body,
        localCalls: [],
        apiCalls: []
      });
      return;
    }
    existing.exported ||= exported;
    // An overload group has signatures first and one implementation last; the
    // implementation is the node whose body the graph is built from.
    if (!existing.body && body) {
      existing.body = body;
      existing.line = node.startPosition.row + 1;
      return;
    }
    // Two bodies under one name: which one is the entry point is a guess, so the
    // entry flow stays away and the function graph carries on.
    if (body) duplicates.add(name);
  };

  const addDeclaration = (node: Node, exported: boolean, isDefault: boolean): void => {
    if (node.type === "identifier") {
      if (isDefault) defaultLocals.push(node.text);
      return;
    }
    if (FUNCTION_TYPES.has(node.type)) {
      const name = node.childForFieldName("name")?.text ?? (isDefault ? "default" : undefined);
      if (name) add(name, node, exported);
      return;
    }
    if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return;
    for (const variable of node.namedChildren) {
      if (variable.type !== "variable_declarator") continue;
      const name = variable.childForFieldName("name");
      const value = variable.childForFieldName("value");
      if (name?.type !== "identifier" || !value || !FUNCTION_TYPES.has(value.type)) continue;
      add(name.text, value, exported);
    }
  };

  for (const statement of root.namedChildren) {
    const exported = statement.type === "export_statement";
    if (!exported) {
      addDeclaration(statement, false, false);
      continue;
    }
    const isDefault = statement.children.some((child) => child.type === "default");
    const declaration = statement.childForFieldName("declaration") ?? statement.childForFieldName("value");
    if (declaration) addDeclaration(declaration, true, isDefault);
    if (statement.childForFieldName("source")) continue;
    const clause = statement.namedChildren.find((child) => child.type === "export_clause");
    for (const specifier of clause?.namedChildren ?? []) {
      if (specifier.type !== "export_specifier" || specifier.children.some((child) => child.type === "type")) continue;
      const local = specifier.childForFieldName("name")?.text;
      const alias = specifier.childForFieldName("alias")?.text;
      if (local) exportAliases.push({ local, alias: alias ?? local });
    }
  }

  for (const local of defaultLocals) {
    const fn = functions.get(local);
    if (fn) fn.exported = true;
  }
  for (const { local } of exportAliases) {
    const fn = functions.get(local);
    if (fn) fn.exported = true;
  }
  return { functions, duplicates };
}

function memberTag(callee: Node, namespaces: ReadonlySet<string>): string | undefined {
  if (callee.type === "member_expression") {
    const object = callee.childForFieldName("object");
    const property = callee.childForFieldName("property");
    return object?.type === "identifier" && namespaces.has(object.text) && property?.type === "property_identifier"
      ? property.text : undefined;
  }
  if (callee.type === "subscript_expression") {
    const object = callee.namedChildren[0];
    const index = callee.namedChildren[1];
    return object?.type === "identifier" && namespaces.has(object.text) && index?.type === "string"
      ? unquote(index.text) : undefined;
  }
  return undefined;
}

/**
 * Collects direct calls in one function body. Nested functions, callbacks and
 * classes are skipped: their calls belong to those functions, not to this one.
 */
function collectCalls(body: Node, tags: ReadonlyMap<string, ApiFlowTag>, namespaces: ReadonlySet<string>, localNames: ReadonlySet<string>) {
  const localCalls: LocalCall[] = [];
  const apiCalls: ApiCall[] = [];
  const visit = (node: Node): void => {
    // A function whose body is itself a function returns a function; calls inside
    // that nested body belong to the returned function, not to this one.
    if (FUNCTION_TYPES.has(node.type) || CLASS_TYPES.has(node.type)) return;
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const line = node.startPosition.row + 1;
      if (callee?.type === "identifier") {
        if (localNames.has(callee.text)) localCalls.push({ name: callee.text, line, index: position(node) });
        else {
          const tag = tags.get(callee.text);
          if (tag) apiCalls.push({ tag, line, index: position(node), callee: callee.text });
        }
      } else if (callee) {
        const name = memberTag(callee, namespaces);
        if (name && isApiFlowTag(name)) apiCalls.push({ tag: name, line, index: position(node), callee: callee.text });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(body);
  return { localCalls, apiCalls };
}

/** Keeps the first occurrence of a name and the source order of the calls. */
function orderedBySource<T extends PositionedCall>(calls: T[]): T[] {
  return [...calls].sort((left, right) => left.index - right.index);
}

function dedupe<T extends PositionedCall>(calls: T[], key: (call: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const call of calls) {
    const value = key(call);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(call);
  }
  return result;
}

function issueFor(rule: ApiFlowIssue["rule"], fn: ApiFlowFunction, message: string, suggestion: string): ApiFlowIssue {
  return { rule, severity: "error", function: fn.name, line: fn.line, message, suggestion };
}

function issuesFor(functions: readonly ApiFlowFunction[]): ApiFlowIssue[] {
  const issues: ApiFlowIssue[] = [];
  for (const fn of functions) {
    const tags = [...new Set(fn.apiCalls.map((call) => call.tag))];
    if (tags.length > 1) {
      issues.push(issueFor(
        "multiple-api-calls", fn,
        `calls ${tags.join(" and ")} directly from one function.`,
        `Split each top-level API call into its own named wrapper (for example ${tags.map((tag) => WRAPPER_EXAMPLES[tag]).join(" and ")}) and compose those wrappers in the entry function.`
      ));
    }
    if (tags.length && fn.calls.length) {
      issues.push(issueFor(
        "api-wrapper-composes", fn,
        `wraps ${tags.join(", ")} but also calls ${fn.calls.join(", ")}.`,
        `Keep this wrapper limited to ${tags.join(", ")}; move local helper calls into the entry function that calls this wrapper.`
      ));
    }
  }
  return issues;
}

/** An end of the statement chain a following statement connects from. */
interface Incoming {
  from: number;
  label?: "yes" | "no";
}

function statementsOf(node: Node | null | undefined): Node[] {
  if (!node) return [];
  return node.type === "statement_block" ? node.namedChildren : [node];
}

/** The first call a statement makes, whether it is `call()`, `await call()` or `const x = await call()`.
 * A call inside a nested function or callback belongs to that function, not here. */
function callOf(statement: Node): Node | undefined {
  const found = (node: Node): Node | undefined => {
    if (node.type === "call_expression") return node;
    if (FUNCTION_TYPES.has(node.type) || CLASS_TYPES.has(node.type)) return undefined;
    for (const child of node.namedChildren) {
      const call = found(child);
      if (call) return call;
    }
    return undefined;
  };
  return found(statement);
}

function clip(text: string): string {
  // A long string literal says nothing in a 44-character box, and its quotes are what
  // Mermaid renders worst, so it becomes one ellipsis. A short one (`"no-plan"`) is the
  // whole meaning of the condition, so it stays.
  const oneLine = text.replace(/\s+/g, " ").replace(/(["'`])(?:\\.|(?!\1).){16,}\1/g, "…").trim();
  return oneLine.length > LABEL_MAX ? `${oneLine.slice(0, LABEL_MAX - 1)}…` : oneLine;
}

/** `if (a && b)` reads as `a && b` in a box that already means "decide". */
function unwrapped(text: string): string {
  let value = text.trim();
  while (value.startsWith("(") && value.endsWith(")")) {
    let depth = 0;
    let closedEarly = false;
    for (const [index, character] of [...value].entries()) {
      if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0 && index < value.length - 1) { closedEarly = true; break; }
    }
    if (closedEarly) break;
    value = value.slice(1, -1).trim();
  }
  return value;
}

/**
 * The statements of the entry function, in source order, as a control-flow graph.
 * One level only: a call to a local function is one step, because what happens
 * inside it is the function graph's job. Anything unrecognised is skipped, so an
 * unusual statement removes itself from the picture instead of emptying it.
 */
function entryFlowFor(
  entryName: string,
  functions: ReadonlyMap<string, WorkingFunction>,
  duplicates: ReadonlySet<string>,
  tags: ReadonlyMap<string, ApiFlowTag>,
  namespaces: ReadonlySet<string>
): ApiFlowEntry | undefined {
  const entry = functions.get(entryName);
  if (!entry?.exported || !entry.body || duplicates.has(entryName)) return undefined;
  const steps: ApiFlowStep[] = [];
  const edges: ApiFlowStepEdge[] = [];

  const node = (kind: ApiFlowStepKind, label: string, tag?: ApiFlowTag): number => {
    steps.push({ id: steps.length, kind, label, ...(tag ? { tag } : {}) });
    return steps.length - 1;
  };
  const connect = (inputs: readonly Incoming[], to: number): void => {
    for (const input of inputs) {
      if (edges.some((edge) => edge.from === input.from && edge.to === to)) continue;
      edges.push({ from: input.from, to, ...(input.label ? { label: input.label } : {}) });
    }
  };
  const branch = (body: Node | null | undefined, inputs: Incoming[]): Incoming[] =>
    statements(body?.type === "else_clause" ? body.namedChildren.at(-1) : body, inputs);

  // Where a `break` and a `continue` land is only known once their loop closes, so each
  // open loop collects the inputs that jumped out of its body.
  const jumps: { exits: Incoming[]; repeats: Incoming[] }[] = [];

  const statement = (current: Node, inputs: Incoming[]): Incoming[] | undefined => {
    if (current.type === "if_statement") {
      const id = node("decision", clip(unwrapped(current.childForFieldName("condition")?.text ?? "if")));
      connect(inputs, id);
      const alternative = current.childForFieldName("alternative");
      return [
        ...branch(current.childForFieldName("consequence"), [{ from: id, label: "yes" }]),
        ...(alternative ? branch(alternative, [{ from: id, label: "no" }]) : [{ from: id, label: "no" as const }])
      ];
    }
    if (LOOP_TYPES.has(current.type)) {
      const body = current.childForFieldName("body");
      const header = current.text.slice(0, body ? body.startIndex - current.startIndex : undefined);
      const condition = current.childForFieldName("condition")?.text;
      const id = node("loop", clip(condition ? unwrapped(condition) : header));
      connect(inputs, id);
      const frame = { exits: [] as Incoming[], repeats: [] as Incoming[] };
      jumps.push(frame);
      const ends = statements(current.childForFieldName("body"), [{ from: id }]);
      jumps.pop();
      connect([...ends, ...frame.repeats], id);
      // A `break` continues with the statement after the loop, exactly like the loop's own exit.
      return [{ from: id }, ...frame.exits];
    }
    if (current.type === "return_statement") {
      // Each branch exits where it stands. One shared end node at the bottom makes
      // every guard clause draw a rail down the whole diagram.
      connect(inputs, node("end", END_LABEL));
      return [];
    }
    // A `break` or a `continue` keeps its arrow: it is wired to the loop it belongs to when
    // that loop closes, so a decision is never drawn with one branch pointing nowhere.
    if (current.type === "break_statement" || current.type === "continue_statement") {
      const frame = jumps.at(-1);
      if (frame) (current.type === "break_statement" ? frame.exits : frame.repeats).push(...inputs);
      return [];
    }
    if (current.type === "try_statement") {
      const id = node("step", "try");
      connect(inputs, id);
      const handler = current.namedChildren.find((child) => child.type === "catch_clause");
      return [
        ...statements(current.childForFieldName("body"), [{ from: id }]),
        ...statements(handler?.childForFieldName("body"), [{ from: id }])
      ];
    }
    const call = callOf(current);
    const callee = call?.childForFieldName("function");
    const name = callee?.text ?? "";
    // `console.log` is the workflow's output, not a step.
    if (!callee || !name || name.startsWith("console.")) return undefined;
    const member = memberTag(callee, namespaces);
    const tag = tags.get(name)
      ?? (member && isApiFlowTag(member) ? member : undefined)
      ?? functions.get(name)?.apiCalls[0]?.tag;
    const step = node("step", `${name} L${call!.startPosition.row + 1}`, tag);
    connect(inputs, step);
    return [{ from: step }];
  };

  function statements(body: Node | null | undefined, inputs: Incoming[]): Incoming[] {
    let ends = inputs;
    for (const child of statementsOf(body)) {
      const next = statement(child, ends);
      if (!next) continue;
      // Nothing continues after a `return`, so the rest of that block is dead.
      if (!next.length) return [];
      ends = next;
    }
    return ends;
  }

  statements(entry.body, [{ from: node("entry", `${entryName} L${entry.line}`) }]);
  return { name: entryName, line: entry.line, steps, edges };
}

/**
 * Builds the function call graph and the single-purpose wrapper issues for an
 * API module. Analysis is syntax-only: the module is never imported or executed.
 * A parse error or a module with no recognisable function yields an empty flow.
 *
 * `entryName` is the API file's leaf (`fix` for `api/dev/fix.ts`): when the module
 * exports that function the flow also carries its statement-level control flow.
 */
export async function describeApiFlow(content: string, assetsPath?: string, entryName?: string): Promise<ApiFlow> {
  const parser = await parserFor("typescript", assetsPath);
  let tree: Tree | null = null;
  try {
    tree = parser.parse(content);
    if (!tree || tree.rootNode.hasError) return EMPTY_API_FLOW;
    const { tags, namespaces } = collectDextImports(tree.rootNode);
    const { functions, duplicates } = collectFunctions(tree.rootNode);
    if (!functions.size) return EMPTY_API_FLOW;
    const localNames = new Set(functions.keys());
    for (const fn of functions.values()) {
      if (!fn.body) continue;
      const { localCalls, apiCalls } = collectCalls(fn.body, tags, namespaces, localNames);
      fn.localCalls = dedupe(orderedBySource(localCalls), (call) => call.name);
      fn.apiCalls = dedupe(orderedBySource(apiCalls), (call) => call.tag);
    }

    // Reachability starts at exported functions and follows direct local calls.
    const reachable = new Set<string>();
    const queue = [...functions.values()].filter((fn) => fn.exported).map((fn) => fn.name);
    while (queue.length) {
      const name = queue.pop()!;
      if (reachable.has(name)) continue;
      reachable.add(name);
      for (const call of functions.get(name)?.localCalls ?? []) if (functions.has(call.name)) queue.push(call.name);
    }

    const edges: ApiFlowEdge[] = [];
    const seenEdges = new Set<string>();
    const ordered = [...functions.values()].sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
    const nodes: ApiFlowFunction[] = ordered.map((fn) => {
      for (const call of fn.localCalls) {
        const key = `${fn.name}\u0000${call.name}`;
        if (!functions.has(call.name) || seenEdges.has(key)) continue;
        seenEdges.add(key);
        edges.push({ from: fn.name, to: call.name, line: call.line });
      }
      return {
        name: fn.name,
        line: fn.line,
        exported: fn.exported,
        calls: fn.localCalls.map((call) => call.name),
        apiCalls: fn.apiCalls.map((call): ApiFlowApiCall => ({ tag: call.tag, line: call.line, callee: call.callee })),
        unused: !reachable.has(fn.name)
      };
    });
    const entry = entryName ? entryFlowFor(entryName, functions, duplicates, tags, namespaces) : undefined;
    return { functions: nodes, edges, issues: issuesFor(nodes), ...(entry ? { entry } : {}) };
  } catch {
    return EMPTY_API_FLOW;
  } finally {
    tree?.delete();
    parser.delete();
  }
}
