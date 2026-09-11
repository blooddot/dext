import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import { builtinApiDefinition } from "./builtinApiDefinitions.js";
import { builtinTypeDefinition } from "./builtinTypeDefinitions.js";
import { methodResultType } from "./methodSignature.js";

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

const scopes = new Set(["FunctionDefinition", "ClassDefinition", "LambdaExpression", "Script"]);

/** Resolve a result member to its declaring built-in type, using preceding
 * assignments in the containing scope rather than matching text in other functions. */
export function builtinMemberDefinitionTarget(source: string, cursor: number): {
  name: string; field: string; originFrom: number; originTo: number;
} | undefined {
  const root = parser.parse(source).topNode;
  const token = [root.resolveInner(cursor, -1), root.resolveInner(cursor, 1)]
    .find((node) => node.name === "PropertyName" && node.from <= cursor && cursor <= node.to);
  const member = token?.parent;
  if (!token || member?.name !== "MemberExpression" || member.lastChild?.from !== token.from) return undefined;
  const text = (node: SyntaxNode): string => source.slice(node.from, node.to);
  const annotation = (node: SyntaxNode | undefined): string | undefined => {
    const name = node && text(node).replace(/^:\s*/, "").trim();
    return name && builtinTypeDefinition(name) ? name : undefined;
  };

  const infer = (expression: SyntaxNode | null, depth = 0): string | undefined => {
    if (!expression || depth > 30) return undefined;
    if (expression.name === "CallExpression") {
      const callee = expression.firstChild;
      const method = callee && builtinApiDefinition(text(callee).replace(/\s+/g, ""));
      return method ? methodResultType(method) : undefined;
    }
    if (expression.name === "MemberExpression") {
      const owner = infer(expression.firstChild, depth + 1);
      const property = expression.lastChild;
      const field = owner && property?.name === "PropertyName"
        ? builtinTypeDefinition(owner)?.fields.find((field) => field.name === text(property)) : undefined;
      return field?.type;
    }
    if (expression.name !== "VariableName") return undefined;
    const name = text(expression);
    for (let scope = expression.parent; scope; scope = scope.parent) {
      if (!scopes.has(scope.name)) continue;
      let bound = false;
      let type: string | undefined;
      const params = scope.getChild("ParamList");
      for (const param of params ? children(params) : []) {
        if (param.name !== "VariableName" || text(param) !== name) continue;
        bound = true;
        type = annotation(param.nextSibling?.name === "TypeDef" ? param.nextSibling : undefined);
      }
      const visit = (node: SyntaxNode): void => {
        if (node.from >= expression.from) return;
        // A separate function/class body cannot bind a local in this scope.
        if (scopes.has(node.name)) return;
        if (node.name === "AssignStatement" && node.to <= expression.from) {
          const parts = children(node);
          if (parts[0]?.name === "VariableName" && text(parts[0]) === name) {
            bound = true;
            const declared = annotation(parts.find((part) => part.name === "TypeDef"));
            const equals = parts.findIndex((part) => part.name === "AssignOp");
            type = declared ?? (equals >= 0 ? infer(parts[equals + 1] ?? null, depth + 1) : undefined);
          }
          return;
        }
        for (const child of children(node)) visit(child);
      };
      for (const child of children(scope)) visit(child);
      if (bound) return type;
    }
    return undefined;
  };

  const name = infer(member.firstChild);
  const field = text(token);
  return name && builtinTypeDefinition(name)?.fields.some((candidate) => candidate.name === field)
    ? { name, field, originFrom: token.from, originTo: token.to } : undefined;
}
