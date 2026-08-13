import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";

export const DEXT_SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "function",
  "parameter",
  "variable",
  "property"
] as const;

export const DEXT_SEMANTIC_TOKEN_MODIFIERS = ["declaration"] as const;

export interface DextSemanticToken {
  from: number;
  to: number;
  type: typeof DEXT_SEMANTIC_TOKEN_TYPES[number];
  declaration?: boolean;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function nodeText(source: string, node: SyntaxNode): string {
  return source.slice(node.from, node.to);
}

function sameNode(left: SyntaxNode | null | undefined, right: SyntaxNode | null | undefined): boolean {
  return Boolean(left && right && left.name === right.name && left.from === right.from && left.to === right.to);
}

function isFunctionCallee(node: SyntaxNode): boolean {
  const parent = node.parent;
  return parent?.name === "CallExpression" && sameNode(parent.firstChild, node);
}

export function dextSemanticTokens(source: string): DextSemanticToken[] {
  const tree = parser.parse(source);
  const parameters = new Set<string>();
  const result: DextSemanticToken[] = [];

  const collectParameters = (node: SyntaxNode): void => {
    if (node.name === "ParamList") {
      for (const child of children(node)) {
        if (child.name === "VariableName") parameters.add(nodeText(source, child));
      }
    }
    for (const child of children(node)) collectParameters(child);
  };
  collectParameters(tree.topNode);

  const add = (
    node: SyntaxNode,
    type: DextSemanticToken["type"],
    declaration = false
  ): void => {
    if (node.to <= node.from) return;
    result.push({ from: node.from, to: node.to, type, ...(declaration ? { declaration: true } : {}) });
  };

  const visit = (node: SyntaxNode): void => {
    const parent = node.parent;
    if (node.name === "PropertyName") {
      add(node, parent && isFunctionCallee(parent) ? "function" : "property");
    } else if (node.name === "VariableName" && parent) {
      const siblings = children(parent);
      const index = siblings.findIndex((candidate) => sameNode(candidate, node));
      if (parent.name === "TypeDef") {
        add(node, "type");
      } else if (parent.name === "FunctionDefinition" && sameNode(siblings.find((child) => child.name === "VariableName"), node)) {
        add(node, "function", true);
      } else if (parent.name === "ParamList") {
        add(node, "parameter", true);
      } else if (parent.name === "ImportStatement") {
        add(node, index === 1 || nodeText(source, parent).startsWith("import ") ? "namespace" : "function", true);
      } else if (parent.name === "ArgList" && siblings[index + 1]?.name === "AssignOp") {
        add(node, "parameter");
      } else if (parent.name === "CallExpression" && sameNode(parent.firstChild, node)) {
        add(node, "function");
      } else if (parent.name === "MemberExpression" && sameNode(parent.firstChild, node) && isFunctionCallee(parent)) {
        add(node, "namespace");
      } else if (parameters.has(nodeText(source, node))) {
        add(node, "parameter");
      } else {
        add(node, "variable", parent.name === "AssignStatement" && sameNode(parent.firstChild, node));
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(tree.topNode);
  return result.sort((left, right) => left.from - right.from || left.to - right.to);
}
