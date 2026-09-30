/**
 * Migrate a `.dx` Dext API to the TypeScript module the kernel now runs.
 *
 * The codemod is deliberately conservative: it rewrites the constructs the old
 * language had an exact equivalent for, and leaves everything else in a comment
 * for a human to finish rather than guessing.
 *
 *   node scripts/migrateDxToTs.mjs .dext/api/git/commit.dx        # writes the .ts beside it
 *   node scripts/migrateDxToTs.mjs <file.dx> --stdout             # prints instead of writing
 *
 * Handled: `def main(...) -> Result:` → `export async function main(...): Promise<Result> {`,
 * assignments and returns of Dext calls, keyword arguments → one object literal,
 * `True`/`False`/`None`, `print(text=…)` → `console.log(…)`, comments, and calls
 * that wrap across lines.
 *
 * Not handled (reported, not guessed): comprehensions, `try/except/finally`,
 * loops, `str` methods, f-string interpolation, and anything else the old
 * language accepted but TypeScript expresses differently.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** `-> AskResult` and friends stay as they are; scalars become TypeScript. */
function tsType(annotation) {
  const type = annotation.trim();
  if (type === "str") return "string";
  if (type === "int" || type === "float") return "number";
  if (type === "bool") return "boolean";
  if (type === "None") return "void";
  if (type.startsWith("list[")) return `${tsType(type.slice(5, -1))}[]`;
  if (type.startsWith("dict[")) {
    const [key, value] = type.slice(5, -1).split(",").map((part) => part.trim());
    return `Record<${tsType(key)}, ${tsType(value)}>`;
  }
  if (type.includes("|")) return type.split("|").map(tsType).join(" | ");
  return type;
}

function tsValue(value) {
  const text = value.trim();
  if (text === "True") return "true";
  if (text === "False") return "false";
  if (text === "None") return "null";
  return text;
}

/** Split `name=a, b="x,y"` on the commas that separate arguments. */
function splitArguments(source) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const CALL = /^([A-Za-z_][\w.]*)\(([\s\S]*)\)$/;

/** `name(a=b, c=d)` → `await name({ a: b, c: d })`; `print(text=x)` → `console.log(x)`. */
function callExpression(statement) {
  const call = CALL.exec(statement.trim());
  if (!call) return statement.trim();
  const [, name, argumentSource] = call;
  const args = splitArguments(argumentSource);
  if (name === "print") {
    const text = args.find((arg) => arg.startsWith("text="));
    return `console.log(${tsValue(text ? text.slice("text=".length) : args.join(", "))})`;
  }
  const pairs = args.map((arg) => {
    const separator = arg.indexOf("=");
    if (separator < 0 || !/^[A-Za-z_]\w*$/.test(arg.slice(0, separator))) {
      throw new Error(`'${name}(...)' must be called with named arguments (${arg.slice(0, 40)}…)`);
    }
    return `${arg.slice(0, separator)}: ${tsValue(arg.slice(separator + 1))}`;
  });
  return `await ${name}({ ${pairs.join(", ")} })`;
}

/** One logical statement, however many lines it wrapped across. */
function translateStatement(statement) {
  const text = statement.trim().replace(/\s+/g, " ");
  if (text.startsWith("return ")) return { code: `return ${callExpression(text.slice("return ".length))};`, imported: true };
  const assignment = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(text);
  if (assignment) return { code: `const ${assignment[1]} = ${callExpression(assignment[2])};`, imported: true };
  return { code: `${callExpression(text)};`, imported: true };
}

function convert(source, file) {
  const notes = [];
  const body = [];
  const imports = new Set();
  /** Result interfaces used as annotations; they need `type` imports. */
  const typeImports = new Set();
  let sawMain = false;
  let pending = null;
  const flush = (statement, indent, lineNumber) => {
    try {
      const translated = translateStatement(statement);
      const expression = translated.code;
      for (const [, name] of expression.matchAll(/\b(?:await|return)\s+([A-Za-z_]\w*)\(/g)) {
        if (!["console", "Promise", "Number", "String", "Boolean", "JSON"].includes(name)) imports.add(name);
      }
      body.push(`${indent}${expression}`);
    } catch (error) {
      notes.push(`${error.message} (line ${lineNumber + 1})`);
      body.push(`${indent}// TODO(migration): ${statement.trim()}`);
    }
  };
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const line = raw.replace(/\t/g, "  ");
    const indent = " ".repeat(Math.max(2, line.length - line.trimStart().length));
    const trimmed = line.trim();
    if (pending) {
      pending.text += ` ${trimmed}`;
      pending.depth += (trimmed.match(/\(/g)?.length ?? 0) - (trimmed.match(/\)/g)?.length ?? 0);
      if (pending.depth <= 0) {
        const { text, indent: pendingIndent, line: pendingLine } = pending;
        pending = null;
        flush(text, pendingIndent, pendingLine);
      }
      continue;
    }
    if (!trimmed) { body.push(""); continue; }
    if (trimmed.startsWith("#")) { body.push(`${indent}//${trimmed.slice(1)}`); continue; }
    const def = /^def\s+([A-Za-z_]\w*)\((.*)\)\s*->\s*([^:]+):$/.exec(trimmed);
    if (def) {
      if (def[1] !== "main") notes.push(`'${def[1]}' is a helper: keep it as a local function or move it to its own module.`);
      const parameters = splitArguments(def[2]).map((parameter) => {
        const [name, annotation, fallback] = parameter.split(/\s*(?::|=)\s*/);
        // A default makes the parameter optional in practice, so it never also
        // carries `?` (TypeScript rejects `?` together with an initializer).
        const optional = fallback === undefined;
        return `${name}${optional ? "?" : ""}: ${annotation ? tsType(annotation) : "unknown"}${fallback !== undefined ? ` = ${tsValue(fallback)}` : ""}`;
      });
      const resultType = tsType(def[3]);
      body.push(`export async function ${def[1]}(${parameters.join(", ")}): Promise<${resultType}> {`);
      // `AgentResult` and friends are exported by the `dext` module rather than
      // declared globally, so a return annotation needs them imported as a type.
      if (/^[A-Z]\w*$/.test(resultType)) typeImports.add(resultType);
      sawMain = true;
      continue;
    }
    if (/^(for|while|try|except|finally|elif)\b/.test(trimmed) || / for .* in /.test(trimmed)) {
      notes.push(`Line ${index + 1} needs a human: ${trimmed.slice(0, 80)}`);
      body.push(`${indent}// TODO(migration): ${trimmed}`);
      continue;
    }
    const open = (trimmed.match(/\(/g)?.length ?? 0) - (trimmed.match(/\)/g)?.length ?? 0);
    if (open > 0) {
      pending = { text: trimmed, depth: open, indent, line: index };
      continue;
    }
    flush(trimmed, indent, index);
  }
  if (pending) flush(pending.text, pending.indent, pending.line);
  if (!sawMain) throw new Error(`${file} has no 'def main(...) -> Result:' signature.`);
  const imported = [...[...imports].sort(), ...[...typeImports].sort().map((name) => `type ${name}`)];
  const header = imported.length ? [`import { ${imported.join(", ")} } from "dext";`, ""] : [];
  const footer = notes.length ? ["", ...notes.map((note) => `// TODO(migration): ${note}`)] : [];
  return { text: [...header, ...body, ...footer].join("\n").replace(/\n{3,}/g, "\n\n") + "\n", notes };
}

const args = process.argv.slice(2);
const toStdout = args.includes("--stdout");
const files = args.filter((arg) => !arg.startsWith("--"));
if (!files.length) {
  console.error("usage: node scripts/migrateDxToTs.mjs <file.dx> [more.dx] [--stdout]");
  process.exit(2);
}
for (const file of files) {
  if (!file.endsWith(".dx")) {
    console.error(`${file}: not a .dx file.`);
    process.exitCode = 1;
    continue;
  }
  const { text, notes } = convert(await readFile(file, "utf8"), file);
  const target = join(dirname(file), `${basename(file, ".dx")}.ts`);
  if (toStdout) process.stdout.write(text);
  else {
    await writeFile(target, text, "utf8");
    console.log(`${file} -> ${target}`);
  }
  for (const note of notes) console.warn(`  note: ${note}`);
  if (notes.length && !toStdout) console.warn(`  ${notes.length} note(s) need a human before this file is finished.`);
}
