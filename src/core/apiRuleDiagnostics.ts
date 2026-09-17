import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import type { DextDiagnostic } from "./apiDiagnostic.js";
import type { CustomApiFile } from "./customApi.js";
import { compileWorkflow } from "./workflow.js";
import type { MethodRegistry } from "./registry.js";

/** Check only statically known rules on builtins; dynamic paths remain runtime checks. */
export async function apiRuleDiagnostics(
  files: readonly CustomApiFile[], registry: MethodRegistry,
  resolveRule: (name: string) => Promise<{ code: string; message: string } | undefined>
): Promise<DextDiagnostic[]> {
  const diagnostics: DextDiagnostic[] = [];
  for (const file of files) {
    const literals: Array<{ value: string; from: number; to: number }> = [];
    const visit = (node: SyntaxNode): void => {
      if (node.name === "CallExpression") {
        const callee = node.firstChild;
        const method = registry.get(callee ? file.source.slice(callee.from, callee.to) : "");
        if (method?.source === "builtin" && method.input.some((field) => field.name === "rules")) {
          const args = node.getChild("ArgList");
          for (let child = args?.firstChild; child; child = child.nextSibling) {
            if (child.name !== "VariableName" || file.source.slice(child.from, child.to) !== "rules" || child.nextSibling?.name !== "AssignOp") continue;
            const value = child.nextSibling.nextSibling;
            if (!value) continue;
            // Reuse the language's string decoding (including escapes) without evaluating code.
            const readLiteral = (literal: SyntaxNode): void => {
              if (literal.name !== "String") return;
              const compiled = compileWorkflow(`print(text=${file.source.slice(literal.from, literal.to)})`, registry);
              const statement = compiled.program?.statements[0];
              if (statement?.kind !== "step") return;
              const expression = statement.call.arguments.find((argument) => argument.name === "text")?.value;
              if (expression?.kind === "literal" && typeof expression.value === "string") literals.push({ value: expression.value, from: literal.from, to: literal.to });
            };
            if (value.name === "ArrayExpression") {
              for (let item = value.firstChild; item; item = item.nextSibling) readLiteral(item);
            } else readLiteral(value);
          }
        }
      }
      for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
    };
    visit(parser.parse(file.source).topNode);
    for (const literal of literals) {
      const resolved = await resolveRule(literal.value);
      if (resolved) diagnostics.push({ path: file.path, apiId: file.id, severity: "error", code: resolved.code, message: resolved.message, from: literal.from, to: literal.to });
    }
  }
  return diagnostics;
}
