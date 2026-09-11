import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import type { FieldDefinition, RegisteredCallable } from "./types.js";
import type { LanguageHover } from "./languageService.js";
import { builtinTypeDefinition, builtinTypeSignature } from "./builtinTypeDefinitions.js";
import { builtinTypeDefinitionTarget, builtinTypeReferenceTarget } from "./apiNavigation.js";
import { formatFieldType, formatMethodParameter, formatMethodSignature, methodResultType } from "./methodSignature.js";
import { splitTopLevel } from "./pythonType.js";
import { specializeBuiltinCli } from "./builtinCli.js";

interface ValueType {
  type: string;
  fields?: readonly FieldDefinition[] | undefined;
  item?: ValueType | undefined;
  documentation?: string | undefined;
}

interface Binding {
  value?: ValueType | undefined;
  kind?: "parameter" | undefined;
}

const scopes = new Set(["Script", "FunctionDefinition", "ClassDefinition", "LambdaExpression"]);

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

/** Resolve the syntax role first: a keyword argument or local binding takes
 * precedence over an identically named API. Never interpret prompt text as code. */
export function documentSymbolHover(
  source: string, cursor: number, resolveMethod: (name: string) => RegisteredCallable | undefined
): LanguageHover | undefined {
  const root = parser.parse(source).topNode;
  const token = [root.resolveInner(cursor, 1), root.resolveInner(cursor, -1)]
    .find((node) => ["VariableName", "PropertyName"].includes(node.name) && node.from <= cursor && cursor < node.to);
  if (!token) return undefined;
  const text = (node: SyntaxNode): string => source.slice(node.from, node.to);
  const name = text(token);
  const range = { rangeStart: token.from, rangeEnd: token.to };
  const fieldValue = (field: FieldDefinition): ValueType => ({
    type: `${formatFieldType(field)}${field.required ? "" : " | undefined"}`,
    fields: field.properties,
    item: field.items ? fieldValue(field.items) : undefined,
    documentation: field.description
  });
  const annotation = (node: SyntaxNode | null | undefined): ValueType | undefined =>
    node?.name === "TypeDef" ? { type: text(node).replace(/^:\s*/, "").trim() } : undefined;
  const concreteType = (value: ValueType): string => splitTopLevel(value.type, "|")
    .map((part) => part.trim()).filter((part) => !["None", "undefined"].includes(part)).join(" | ");
  const propertyValue = (owner: ValueType, property: string): ValueType | undefined => {
    const type = concreteType(owner);
    // A mapping's value properties are available only after an index.
    if (type.startsWith("dict[")) return undefined;
    const declared = owner.fields?.find((field) => field.name === property);
    if (declared) return fieldValue(declared);
    const field = builtinTypeDefinition(type)?.fields.find((field) => field.name === property);
    return field ? {
      type: `${field.type}${field.optional ? " | undefined" : ""}`,
      documentation: field.description
    } : undefined;
  };
  const indexedValue = (owner: ValueType): ValueType | undefined => {
    if (owner.item) return owner.item;
    const type = concreteType(owner);
    const mapping = /^dict\[([\s\S]*)\]$/.exec(type);
    if (mapping) {
      const value = splitTopLevel(mapping[1]!, ",")[1]?.trim();
      return value ? { type: value, fields: owner.fields } : undefined;
    }
    const list = /^list\[([\s\S]*)\]$/.exec(type);
    if (list) return { type: list[1]! };
    return type.endsWith("[]") ? { type: type.slice(0, -2) } : undefined;
  };

  const assignmentValue = (node: SyntaxNode, depth: number): ValueType | undefined => {
    const parts = children(node);
    const declared = annotation(parts.find((part) => part.name === "TypeDef"));
    const equals = parts.findIndex((part) => part.name === "AssignOp");
    return declared ?? (equals >= 0 ? infer(parts[equals + 1], depth + 1) : undefined);
  };
  const binding = (expression: SyntaxNode, depth: number): Binding | undefined => {
    if (depth > 30) return undefined;
    const variable = text(expression);
    for (let scope = expression.parent; scope; scope = scope.parent) {
      if (!scopes.has(scope.name)) continue;
      let found: Binding | undefined;
      const parameters = scope.getChild("ParamList");
      for (const param of parameters ? children(parameters) : []) {
        if (param.name === "VariableName" && text(param) === variable) {
          found = { value: annotation(param.nextSibling), kind: "parameter" };
        }
      }
      const visit = (node: SyntaxNode): void => {
        if (node.from >= expression.from || scopes.has(node.name)) return;
        if (node.name === "AssignStatement" && node.to <= expression.from) {
          if (node.firstChild?.name === "VariableName" && text(node.firstChild) === variable) {
            found = { value: assignmentValue(node, depth + 1) };
          }
          return;
        }
        for (const child of children(node)) visit(child);
      };
      for (const child of children(scope)) visit(child);
      if (found) return found;
    }
    return undefined;
  };
  const infer = (expression: SyntaxNode | null | undefined, depth = 0): ValueType | undefined => {
    if (!expression || depth > 30) return undefined;
    if (expression.name === "CallExpression") {
      const method = expression.firstChild && resolveMethod(text(expression.firstChild).replace(/\s+/g, ""));
      return method ? {
        type: methodResultType(method), fields: method.output.fields,
        documentation: `Result returned by ${method.id}.`
      } : undefined;
    }
    if (expression.name === "MemberExpression") {
      const owner = infer(expression.firstChild, depth + 1);
      if (!owner) return undefined;
      return expression.lastChild?.name === "PropertyName"
        ? propertyValue(owner, text(expression.lastChild)) : indexedValue(owner);
    }
    if (expression.name === "VariableName") return binding(expression, depth + 1)?.value;
    if (expression.name === "Boolean") return { type: "boolean" };
    if (expression.name === "String") return { type: "string" };
    if (expression.name === "Number") return { type: "number" };
    if (expression.name === "ParenthesizedExpression") return infer(expression.firstChild?.nextSibling, depth + 1);
    return undefined;
  };

  // Keywords belong to the nearest containing call, including nested calls.
  if (token.parent?.name === "ArgList" && token.nextSibling?.name === "AssignOp") {
    const args = token.parent;
    const callee = args.parent?.firstChild;
    const resolved = callee && resolveMethod(text(callee).replace(/\s+/g, ""));
    let cli: string | undefined;
    for (const arg of children(args)) {
      if (arg.name === "VariableName" && text(arg) === "cli" && arg.nextSibling?.name === "AssignOp") {
        const value = arg.nextSibling.nextSibling;
        if (value?.name === "String") cli = text(value).slice(1, -1);
      }
    }
    const method = resolved && specializeBuiltinCli(resolved, cli);
    const field = method?.input.find((candidate) => candidate.name === name);
    return field ? { ...range, kind: "parameter", label: formatMethodParameter(field), documentation: field.description ?? `Parameter of ${method!.id}.` } : undefined;
  }

  if (token.parent?.name === "ParamList") {
    const value = annotation(token.nextSibling);
    return value ? { ...range, kind: "parameter", label: `${name}: ${value.type}`, documentation: "Function parameter." } : undefined;
  }
  if (token.parent?.name === "AssignStatement" && token.parent.firstChild?.from === token.from) {
    const value = assignmentValue(token.parent, 0);
    return value ? { ...range, label: `${name}: ${value.type}`, documentation: value.documentation ?? "Local variable." } : undefined;
  }

  const typeTarget = builtinTypeDefinitionTarget(source, cursor) ?? builtinTypeReferenceTarget(source, cursor);
  const definition = typeTarget && builtinTypeDefinition(typeTarget.name);
  if (typeTarget && definition) return {
    rangeStart: typeTarget.originFrom, rangeEnd: typeTarget.originTo,
    label: builtinTypeSignature(definition),
    documentation: `${definition.description} Use Go to Definition to inspect the complete built-in type document.`
  };

  if (token.name === "PropertyName" && token.parent?.name === "MemberExpression") {
    const value = infer(token.parent);
    if (value) return { ...range, label: `${text(token.parent)}: ${value.type}`, documentation: value.documentation ?? "Result field." };
  }
  if (token.name === "VariableName") {
    const local = binding(token, 0);
    if (local) return local.value ? {
      ...range, ...(local.kind ? { kind: local.kind } : {}), label: `${name}: ${local.value.type}`,
      documentation: local.value.documentation ?? (local.kind === "parameter" ? "Function parameter." : "Local variable.")
    } : undefined;
  }
  // Only the callee or a function declaration is eligible for a method hover.
  let callee = token;
  while (callee.parent?.name === "MemberExpression") callee = callee.parent;
  if (!(callee.parent?.name === "CallExpression" && callee.parent.firstChild?.from === callee.from)
    && token.parent?.name !== "FunctionDefinition") return undefined;
  const method = resolveMethod(source.slice(callee.from, token.to).replace(/\s+/g, ""));
  return method ? {
    ...range, label: formatMethodSignature(method, ["agent", "ask", "plan"].includes(method.id) ? { includeInternal: true } : undefined),
    documentation: method.description
  } : undefined;
}
