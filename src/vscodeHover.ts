import { pythonShapeMembers, pythonType, splitTopLevel } from "./core/pythonType.js";

/** Convert a Dext value default (JSON-ish) to a Python literal. */
function pythonValue(value: string): string {
  return value.replace(/"(?:\\.|[^"\\])*"|\btrue\b|\bfalse\b|\bnull\b/g, (token) =>
    token === "true" ? "True" : token === "false" ? "False" : token === "null" ? "None" : token);
}

/** Convert one `name?: type = default` parameter to Python. */
function pythonParameter(parameter: string): string {
  const match = /^\s*([A-Za-z_]\w*)(\?)?: ([\s\S]*?)(?: = ([\s\S]*))?\s*$/.exec(parameter);
  if (!match) return parameter.trim();
  const optional = Boolean(match[2]);
  const annotation = `${match[1]}: ${pythonType(match[3]!)}${optional && match[4] === undefined ? " | None" : ""}`;
  if (match[4] === undefined) return `${annotation}${optional ? " = None" : ""}`;
  return `${annotation} = ${pythonValue(match[4])}`;
}

function indent(lines: string[]): string[] {
  return lines.map((line) => (line ? `    ${line}` : line));
}

/** Declare a class whose dotted name becomes nested namespace classes. */
function pythonClass(name: string, members: string[]): string {
  const segments = name.split(".");
  let lines = [`class ${segments.pop()!}:`, ...(members.length ? indent(members) : ["    ..."])];
  for (const namespace of segments.reverse()) lines = [`class ${namespace}:`, ...indent(lines)];
  return lines.join("\n");
}

/** Declare a function, nested in namespace classes when its name is dotted. */
function pythonCallable(name: string, parameters: string, result: string): string {
  const segments = name.split(".");
  let lines = [`def ${segments.pop()!}(${parameters}) -> ${result}:`, "    ..."];
  for (const namespace of segments.reverse()) lines = [`class ${namespace}:`, ...indent(lines)];
  return lines.join("\n");
}

/** Turn language-service summaries into declarations understood by VS Code's Python grammar. */
export function pythonHoverCode(label: string, kind?: "parameter"): string {
  if (kind === "parameter") return `(parameter) ${pythonParameter(label)}`;
  const memberShape = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*): \{ ([\s\S]*) \}$/.exec(label);
  if (memberShape) {
    const name = memberShape[1]!.split(".").at(-1)!.replace(/[^A-Za-z0-9_]/g, "_");
    const className = `${name.slice(0, 1).toUpperCase()}${name.slice(1)}Shape`;
    const fields = pythonShapeMembers(memberShape[2]!).map((field) => `    ${field}`);
    return `class ${className}:\n${fields.join("\n")}\n\n${memberShape[1]}: ${className}`;
  }
  const shape = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*) \{ ([\s\S]*) \}$/.exec(label);
  if (shape) return pythonClass(shape[1]!, pythonShapeMembers(shape[2]!));
  const call = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\(([\s\S]*)\) -> ([\s\S]*)$/.exec(label);
  if (call) {
    const parameters = splitTopLevel(call[2]!, ",").map(pythonParameter).join(", ");
    return pythonCallable(call[1]!, parameters, pythonType(call[3]!));
  }
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\(/.test(label)) return `def ${label}:\n    ...`;
  const member = /^([A-Za-z_]\w*(?:(?:\.[A-Za-z_]\w*)|(?:\[[^\]\r\n]*\]))*): ([\s\S]*)$/.exec(label);
  if (member) return `${member[1]}: ${pythonType(member[2]!)}`;
  return label;
}
