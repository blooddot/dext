import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import { parseWorkflowImports } from "./workflow.js";
import { builtinTypeDefinition } from "./builtinTypeDefinitions.js";
import { isBuiltinApiTarget } from "./builtinApiDefinitions.js";

export interface DefinitionRange {
  from: number;
  to: number;
  nameFrom: number;
  nameTo: number;
}

export interface ApiDefinitionTarget {
  originFrom: number;
  originTo: number;
  /** Absent for a function in the current document. */
  apiId?: string;
  name: string;
}

export interface BuiltinTypeTarget {
  originFrom: number;
  originTo: number;
  name: string;
}

export interface BuiltinApiTarget {
  originFrom: number;
  originTo: number;
  id: string;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const nodes: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) nodes.push(child);
  return nodes;
}

/** Navigation also works while a function's signature or body is being edited. */
export function apiFunctionDefinition(source: string, name: string): DefinitionRange | undefined {
  for (const top of children(parser.parse(source).topNode)) {
    const node = top.name === "DecoratedStatement"
      ? children(top).find((child) => child.name === "FunctionDefinition") : top;
    if (node?.name !== "FunctionDefinition") continue;
    const identifier = children(node).find((child) => child.name === "VariableName");
    if (identifier && source.slice(identifier.from, identifier.to) === name) {
      return { from: top.from, to: top.to, nameFrom: identifier.from, nameTo: identifier.to };
    }
  }
  return undefined;
}

/** Resolve only import names and call sites, never text in prompts or comments. */
export function apiDefinitionTarget(source: string, cursor: number): ApiDefinitionTarget | undefined {
  const root = parser.parse(source).topNode;
  const token = [root.resolveInner(cursor, -1), root.resolveInner(cursor, 1)]
    .find((node) => ["VariableName", "PropertyName"].includes(node.name) && node.from <= cursor && cursor <= node.to);
  if (!token) return undefined;
  const imports = new Map<string, string>();
  for (const node of children(root)) {
    if (node.name !== "ImportStatement") continue;
    for (const [alias, id] of parseWorkflowImports(source.slice(node.from, node.to))) imports.set(alias, id);
  }
  if (token.parent?.name === "ImportStatement") {
    const statement = token.parent;
    const parts = children(statement);
    const importIndex = parts.findIndex((node) => node.name === "import");
    if (parts.findIndex((node) => node.from === token.from && node.to === token.to) <= importIndex) return undefined;
    const id = [...parseWorkflowImports(source.slice(statement.from, statement.to)).values()][0];
    return id ? { originFrom: token.from, originTo: token.to, apiId: id, name: "main" } : undefined;
  }
  let callee = token;
  while (callee.parent?.name === "MemberExpression") callee = callee.parent;
  if (callee.parent?.name !== "CallExpression" || callee.parent.firstChild?.from !== callee.from) return undefined;
  const name = source.slice(callee.from, callee.to).replace(/\s+/g, "");
  const origin = { originFrom: callee.from, originTo: callee.to };
  if (apiFunctionDefinition(source, name)) return { ...origin, name };
  const [head, ...tail] = name.split(".");
  const imported = imports.get(head!);
  return imported ? { ...origin, apiId: [imported, ...tail].join("."), name: "main" } : undefined;
}

/** Resolve a known built-in type only when it is used as a Python type annotation. */
export function builtinTypeDefinitionTarget(source: string, cursor: number): BuiltinTypeTarget | undefined {
  const root = parser.parse(source).topNode;
  const token = [root.resolveInner(cursor, -1), root.resolveInner(cursor, 1)]
    .find((node) => ["VariableName", "PropertyName"].includes(node.name) && node.from <= cursor && cursor <= node.to);
  if (!token) return undefined;
  for (let candidate: SyntaxNode | null = token; candidate && candidate.name !== "TypeDef"; candidate = candidate.parent) {
    const name = source.slice(candidate.from, candidate.to).replace(/\s+/g, "");
    if (builtinTypeDefinition(name)) return { originFrom: candidate.from, originTo: candidate.to, name };
  }
  return undefined;
}

/** Resolve a built-in type name in the generated type document. */
export function builtinTypeReferenceTarget(source: string, cursor: number): BuiltinTypeTarget | undefined {
  const match = [...source.matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)].find((candidate) => {
    const from = candidate.index ?? 0;
    return from <= cursor && cursor <= from + candidate[0].length;
  });
  if (!match) return undefined;
  const from = match.index ?? 0;
  const direct = match[0];
  if (builtinTypeDefinition(direct)) return { originFrom: from, originTo: from + direct.length, name: direct };

  // Namespaced types are rendered as ordinary nested Python classes. Recover
  // their qualified Dext type name from the generated marker above the class.
  const lineStart = source.lastIndexOf("\n", from - 1) + 1;
  const lineEnd = source.indexOf("\n", from);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
  if (new RegExp(`^\\s*class\\s+${direct}\\b`).test(line)) {
    const type = [...source.slice(0, lineStart).matchAll(/^\s*# Type: ([A-Za-z][A-Za-z0-9_.-]*)$/gm)].at(-1)?.[1];
    if (type && builtinTypeDefinition(type)) return { originFrom: from, originTo: from + direct.length, name: type };
  }
  return undefined;
}

/** Resolve the API or namespace segment under the cursor, never prompts/comments. */
export function builtinApiDefinitionTarget(source: string, cursor: number): BuiltinApiTarget | undefined {
  const root = parser.parse(source).topNode;
  const token = [root.resolveInner(cursor, -1), root.resolveInner(cursor, 1)]
    .find((node) => ["VariableName", "PropertyName"].includes(node.name) && node.from <= cursor && cursor <= node.to);
  if (!token) return undefined;
  let callee = token;
  while (callee.parent?.name === "MemberExpression") callee = callee.parent;
  if (callee.parent?.name !== "CallExpression" || callee.parent.firstChild?.from !== callee.from) return undefined;
  const segments = [...source.slice(callee.from, callee.to).matchAll(/[A-Za-z_]\w*/g)]
    .map((match) => ({ name: match[0], from: callee.from + (match.index ?? 0), to: callee.from + (match.index ?? 0) + match[0].length }));
  const index = segments.findIndex((segment) => segment.from <= cursor && cursor <= segment.to);
  if (index < 0) return undefined;
  const segment = segments[index]!;
  const id = segments.slice(0, index + 1).map((part) => part.name).join(".");
  return isBuiltinApiTarget(id) ? { originFrom: segment.from, originTo: segment.to, id } : undefined;
}
