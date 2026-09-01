import { parser } from "@lezer/python";
import type { SyntaxNode } from "@lezer/common";
import { parserCompatibleSource } from "./core/workflow.js";

export type DextHighlightKind = "property" | "function";

/** Return the Dext-specific token kinds that Python's generic highlighter
 * cannot infer (keyword arguments and bare call names). */
export function dextHighlightRanges(source: string): Map<string, DextHighlightKind> {
  const ranges = new Map<string, DextHighlightKind>();
  const children = (node: SyntaxNode): SyntaxNode[] => {
    const result: SyntaxNode[] = [];
    for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
    return result;
  };
  const visit = (node: SyntaxNode): void => {
    if (node.name === "CallExpression") {
      const first = node.firstChild;
      if (first?.name === "VariableName") ranges.set(`${first.from}:${first.to}`, "function");
    }
    if (node.name === "ArgList") {
      const args = children(node);
      for (let index = 0; index + 1 < args.length; index += 1) {
        const name = args[index]!;
        if (name.name === "VariableName" && args[index + 1]!.name === "AssignOp") {
          ranges.set(`${name.from}:${name.to}`, "property");
        }
      }
    }
    for (const child of children(node)) visit(child);
  };
  visit(parser.parse(parserCompatibleSource(source)).topNode);
  return ranges;
}

export function dextHighlightClass(
  classes: string | null,
  sourceOffset: number,
  text: string,
  ranges: ReadonlyMap<string, DextHighlightKind>
): string | null {
  const kind = ranges.get(`${sourceOffset}:${sourceOffset + text.length}`);
  if (!kind) return classes;
  return kind === "property" ? "tok-propertyName" : "tok-function";
}
