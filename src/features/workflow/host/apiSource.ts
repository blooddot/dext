import type { Node, Tree } from "web-tree-sitter";
import { parserFor } from "../../../platform/node/syntaxParser.js";
import type { ApiSourceFunction } from "../contracts/apiReference.js";

export type { ApiSourceFunction } from "../contracts/apiReference.js";

function docComment(node: Node): string {
  const previous = node.previousNamedSibling;
  return previous?.type === "comment" && previous.text.startsWith("/**")
    ? previous.text.replace(/^\/\*\*|\*\/$/g, "").split(/\r?\n/).map(line => line.replace(/^\s*\* ?/, "").trim()).join("\n").trim()
    : "";
}

function literalType(node: Node | null): string {
  switch (node?.type) {
    case "string": case "template_string": return "string";
    case "number": return node.text.endsWith("n") ? "bigint" : "number";
    case "true": case "false": return "boolean";
    case "null": return "null";
    case "unary_expression": return /^[-+]\s*\d/.test(node.text) ? "number" : "unknown";
    default: return "unknown";
  }
}

function describe(name: string, node: Node, comment: string): ApiSourceFunction {
  const description = comment.split(/^\s*@/m)[0]!.trim();
  const paramDocs = new Map([...comment.matchAll(/^@param\s+(?:\{[^}]*\}\s*)?(\[[^\]]+\]|\S+)\s*-?\s*([\s\S]*?)(?=\n@|$)/gm)]
    .map(([, key, text]) => [key!.replace(/^\[|\]$/g, "").split("=")[0]!, text!.trim()]));
  const parameters = (node.childForFieldName("parameters")?.namedChildren ?? [node.childForFieldName("parameter")].filter((item): item is Node => !!item))
    .filter(parameter => parameter.type !== "comment")
    .map(parameter => {
      const pattern = parameter.childForFieldName("pattern") ?? parameter.childForFieldName("name") ?? parameter;
      const value = parameter.childForFieldName("value");
      const annotation = parameter.childForFieldName("type");
      const name = pattern.text;
      const description = paramDocs.get(name.replace(/^\.\.\./, ""));
      return {
        name, type: annotation?.text.replace(/^:\s*/, "") ?? literalType(value),
        required: parameter.type !== "optional_parameter" && !value && pattern.type !== "rest_pattern",
        ...(value ? { defaultValue: value.text } : {}), ...(description ? { description } : {})
      };
    });
  // This is syntax-only documentation: do not pretend to resolve imported types or infer bodies.
  const returnType = node.childForFieldName("return_type")?.text.replace(/^:\s*/, "") ?? "unknown";
  const typeParameters = node.childForFieldName("type_parameters")?.text;
  return {
    name, ...(description ? { description } : {}),
    api: {
      signature: `${name}${typeParameters ?? ""}(${parameters.map(parameter => `${parameter.name}${parameter.required ? "" : "?"}: ${parameter.type}`).join(", ")}) -> ${returnType}`,
      ...(typeParameters ? { typeParameters } : {}), parameters, returnType
    }
  };
}

/** Read exported functions and their JSDoc without importing or executing user code. */
export async function describeApiSource(content: string, assetsPath?: string): Promise<ApiSourceFunction[]> {
  const parser = await parserFor("typescript", assetsPath);
  let tree: Tree | null = null;
  try {
    tree = parser.parse(content);
    if (!tree) return [];
    const declarations = new Map<string, Array<{ node: Node; comment: string }>>();
    const exports: Array<{ local: string; name: string }> = [];
    const add = (name: string, node: Node, comment: string) => {
      declarations.set(name, [...declarations.get(name) ?? [], { node, comment }]);
    };
    for (const statement of tree.rootNode.namedChildren) {
      const exported = statement.type === "export_statement";
      if (exported && statement.children.some(child => child.type === "type")) continue;
      const declaration = exported ? statement.childForFieldName("declaration") ?? statement.childForFieldName("value") : statement;
      const isDefault = exported && statement.children.some(child => child.type === "default");
      const comment = docComment(statement);
      if (declaration && !declaration.hasError) {
        if (["function_declaration", "function_signature", "function_expression", "arrow_function"].includes(declaration.type)) {
          const name = declaration.childForFieldName("name")?.text ?? "default";
          add(name, declaration, comment);
          if (exported) exports.push({ local: name, name: isDefault ? "default" : name });
        } else if (["lexical_declaration", "variable_declaration"].includes(declaration.type)) {
          for (const variable of declaration.namedChildren) {
            const name = variable.childForFieldName("name");
            const value = variable.childForFieldName("value");
            if (name?.type !== "identifier" || !value || !["arrow_function", "function_expression"].includes(value.type)) continue;
            add(name.text, value, comment);
            if (exported) exports.push({ local: name.text, name: name.text });
          }
        } else if (isDefault && declaration.type === "identifier") {
          exports.push({ local: declaration.text, name: "default" });
        }
      }
      // Local export aliases are readable without following or executing another module.
      if (exported && !statement.childForFieldName("source")) {
        const clause = statement.namedChildren.find(child => child.type === "export_clause");
        for (const specifier of clause?.namedChildren ?? []) {
          if (specifier.children.some(child => child.type === "type")) continue;
          const name = specifier.childForFieldName("name");
          if (name) exports.push({ local: name.text, name: specifier.childForFieldName("alias")?.text ?? name.text });
        }
      }
    }
    const result: ApiSourceFunction[] = [];
    for (const { local, name } of exports) {
      const candidates = declarations.get(local) ?? [];
      const overloads = candidates.filter(candidate => candidate.node.type === "function_signature");
      for (const { node, comment } of overloads.length ? overloads : candidates) {
        const item = describe(name, node, comment);
        if (!result.some(existing => existing.api.signature === item.api.signature)) result.push(item);
      }
    }
    return result;
  } finally {
    tree?.delete();
    parser.delete();
  }
}
