import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import { parseWorkflowImports } from "./workflow.js";

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
