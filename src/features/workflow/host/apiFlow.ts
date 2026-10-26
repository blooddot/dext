import type { Node, Tree } from "web-tree-sitter";
import { parserFor } from "../../../platform/node/syntaxParser.js";
import {
  EMPTY_API_FLOW,
  isApiFlowTag,
  type ApiFlow,
  type ApiFlowApiCall,
  type ApiFlowEdge,
  type ApiFlowFunction,
  type ApiFlowIssue,
  type ApiFlowTag
} from "../contracts/apiFlow.js";

const FUNCTION_TYPES = new Set(["function_declaration", "function_signature", "function_expression", "arrow_function"]);
const CLASS_TYPES = new Set(["class_declaration", "class", "abstract_class_declaration", "class_expression"]);
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
function collectFunctions(root: Node): Map<string, WorkingFunction> {
  const functions = new Map<string, WorkingFunction>();
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
    }
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
  return functions;
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

/**
 * Builds the function call graph and the single-purpose wrapper issues for an
 * API module. Analysis is syntax-only: the module is never imported or executed.
 * A parse error or a module with no recognisable function yields an empty flow.
 */
export async function describeApiFlow(content: string, assetsPath?: string): Promise<ApiFlow> {
  const parser = await parserFor("typescript", assetsPath);
  let tree: Tree | null = null;
  try {
    tree = parser.parse(content);
    if (!tree || tree.rootNode.hasError) return EMPTY_API_FLOW;
    const { tags, namespaces } = collectDextImports(tree.rootNode);
    const functions = collectFunctions(tree.rootNode);
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
    return { functions: nodes, edges, issues: issuesFor(nodes) };
  } catch {
    return EMPTY_API_FLOW;
  } finally {
    tree?.delete();
    parser.delete();
  }
}
