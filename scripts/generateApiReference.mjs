/**
 * Generates the Node and JavaScript API reference the APIs page lists.
 *
 *   node scripts/generateApiReference.mjs [--check]
 *
 * Nothing in the catalog is written by hand. Every signature is the declaration's
 * own signature and every description is the JSDoc the declaration carries, read
 * through the TypeScript compiler:
 *
 * - `node` entries are the Node built-in modules `@types/node` declares
 *   (`declare module "node:fs/promises"`) plus the values Node adds to the global
 *   scope (`process`, `Buffer`, `fetch`, `setTimeout`, …), which are the globals
 *   `@types/node` contributes on top of the ECMAScript library.
 * - `js` entries are the ECMAScript standard library globals TypeScript's own
 *   `lib.es*.d.ts` files declare (`JSON`, `Math`, `Date`, `Promise`, `Array`, …).
 *
 * The catalog is a build artifact: `esbuild.mjs` writes it to
 * `dist/api-reference.json`, the extension reads it lazily, and `npm run check`
 * proves the shipped file still matches these declarations.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The shipped catalog; `esbuild.mjs` writes it. */
export const API_REFERENCE_PATH = path.join(root, "dist", "api-reference.json");

/** The catalog format, so a build can be recognised against a newer reader. */
export const API_REFERENCE_VERSION = 1;

/** A single description is a screenful at most; a declaration's prose is not
 * reproduced past this length. */
const DOCUMENTATION_LIMIT = 2400;
/** An `@example` block is kept short: it is a hint, not a manual. */
const EXAMPLE_LIMIT = 800;
/** A parameter's own description. */
const PARAM_LIMIT = 600;
/** A rendered signature stays readable instead of printing an inlined object type. */
const SIGNATURE_LIMIT = 900;
/** How many overloads a member shows before the rest are dropped. */
const OVERLOAD_LIMIT = 4;
/** A type printed for a variable stays a type name rather than a whole literal. */
const TYPE_LIMIT = 160;
/** How deep a member's own members are followed: a class shows its methods, and a
 * namespace one level below (`Intl.NumberFormat`, `fs.promises`) shows theirs. */
const MEMBER_DEPTH = 2;
/** Values that exist but are not APIs worth listing: language aliases, and the
 * CommonJS module wrapper, which an ES module never sees. */
const SKIPPED_GLOBALS = new Set([
  "undefined", "NaN", "Infinity", "globalThis",
  "require", "module", "exports", "global", "gc"
]);

/** Normalise declaration prose: no CRLF, no trailing spaces, no run of blank lines. */
function plainText(parts) {
  return ts.displayPartsToString(parts ?? [])
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(value, limit) {
  const text = (value ?? "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function documentationOf(symbol, checker) {
  return clip(plainText(symbol.getDocumentationComment(checker)), DOCUMENTATION_LIMIT) || undefined;
}

/** The `@param`, `@returns`, `@deprecated` and `@example` tags of one declaration. */
function tagsOf(symbol, checker) {
  const params = [];
  let deprecated;
  let returns;
  let example;
  for (const tag of symbol.getJsDocTags(checker)) {
    const value = plainText(tag.text);
    if (tag.name === "param") {
      // `@param name description`, or `@param {Type} name description`.
      const match = /^(?:\{[^}]*\}\s*)?(\S+)\s*(?:-\s*)?([\s\S]*)$/.exec(value);
      const text = match ? clip(match[2], PARAM_LIMIT) : "";
      // A name with no description documents nothing the signature does not.
      if (match && text) params.push({ name: match[1].replace(/^\[|\]$/g, ""), text });
      continue;
    }
    if (tag.name === "deprecated") deprecated = clip(value || "This API is deprecated.", PARAM_LIMIT);
    else if (tag.name === "returns" || tag.name === "return") returns = clip(value, PARAM_LIMIT);
    else if (tag.name === "example") example = clip(value, EXAMPLE_LIMIT);
  }
  return {
    ...(params.length ? { params: params.filter((param, index) => params.findIndex((candidate) => candidate.name === param.name) === index) } : {}),
    ...(deprecated ? { deprecated } : {}),
    ...(returns ? { returns } : {}),
    ...(example ? { example } : {})
  };
}

/** A member name that is a real API name rather than a symbol-keyed internal, an
 * ambient module (`"node:fs"`), or a quoted module specifier. */
function usableName(name) {
  return Boolean(name)
    && name !== "prototype"
    && !name.startsWith("__")
    && !name.includes("@")
    && !name.startsWith("[")
    && !name.startsWith("\"");
}

function isPrivateMember(symbol) {
  return (symbol.declarations ?? []).some((declaration) => {
    const flags = ts.getCombinedModifierFlags(declaration);
    return (flags & ts.ModifierFlags.Private) !== 0 || (flags & ts.ModifierFlags.Protected) !== 0;
  });
}

function isStaticMember(symbol) {
  return (symbol.declarations ?? []).some((declaration) =>
    (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) !== 0);
}

/** A type printed for a declaration: a named type stays a name, and an inlined
 * object type is cut short instead of printing every property. */
function typeText(type, checker, node) {
  const text = checker.typeToString(type, node, ts.TypeFormatFlags.NoTruncation).replace(/\s+/g, " ");
  if (text.length <= TYPE_LIMIT) return text;
  const name = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
  return name && name.length <= 60 ? name : `${text.slice(0, TYPE_LIMIT - 1)}…`;
}

/** The call signatures of a type, in declaration order, as the argument lists a
 * call site writes (`(path: PathLike): Promise<void>`); the name is added by the
 * member renderer, so every overload reads as part of the same API. */
function callLines(type, checker, node) {
  return type.getCallSignatures().slice(0, OVERLOAD_LIMIT)
    .map((signature) => clip(checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation), SIGNATURE_LIMIT))
    .filter(Boolean);
}

function kindOf(symbol, type, checker) {
  // The type says more about how a name is used than the declaration does: a
  // global like `Array` is both an interface and a value, and what a reader wants
  // to know is that it is constructed.
  if (type.getConstructSignatures().length) return "class";
  if (type.getCallSignatures().length) return "function";
  // A value typed by an interface of its own name (`JSON`, `Math`) is the global
  // object those statics hang off, not a variable of that type.
  if ((type.getSymbol() ?? type.aliasSymbol)?.getName() === symbol.getName()
    && checker.getPropertiesOfType(type).length > 0) return "namespace";
  const flags = symbol.flags;
  if ((flags & ts.SymbolFlags.Namespace) !== 0) return "namespace";
  if ((flags & ts.SymbolFlags.Class) !== 0) return "class";
  if ((flags & ts.SymbolFlags.Interface) !== 0) return "interface";
  if ((flags & ts.SymbolFlags.TypeAlias) !== 0) return "type";
  if ((flags & ts.SymbolFlags.Enum) !== 0) return "enum";
  if ((flags & ts.SymbolFlags.Method) !== 0) return "method";
  return "variable";
}

/** The members of a class, interface or namespace, one level deep. */
function nestedMembers(type, checker, node, depth, isStatic = false) {
  if (depth <= 0) return [];
  return checker.getPropertiesOfType(type)
    .filter((property) => usableName(property.getName()) && !isPrivateMember(property))
    .map((property) => memberOf(property, checker, node, depth - 1, isStatic))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** A constructor as a member, so instantiating a class is part of its reference. */
function constructorMember(type, checker, node) {
  const signature = type.getConstructSignatures()[0];
  if (!signature) return undefined;
  const text = checker.signatureToString(signature, node, ts.TypeFormatFlags.NoTruncation);
  return { name: "constructor", kind: "constructor", signature: clip(text, SIGNATURE_LIMIT) };
}

function memberOf(symbol, checker, node, depth, isStatic) {
  const resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  const declaration = resolved.valueDeclaration ?? resolved.declarations?.[0] ?? node;
  const name = symbol.getName();
  const type = checker.getTypeOfSymbolAtLocation(resolved, declaration);
  const kind = kindOf(resolved, type, checker);
  const calls = callLines(type, checker, declaration);
  const staticPrefix = isStatic || isStaticMember(resolved) ? "static " : "";
  let signature;
  if (kind === "class") signature = `${staticPrefix}class ${name}`;
  else if (kind === "interface") signature = `interface ${name}`;
  else if (kind === "type") signature = `type ${name} = ${typeText(type, checker, declaration)}`;
  else if (kind === "namespace") signature = `namespace ${name}`;
  else if (calls.length) signature = calls.map((call) => `${staticPrefix}${name}${call}`).join("\n");
  else signature = `${staticPrefix}${name}: ${typeText(type, checker, declaration)}`;
  const documentation = documentationOf(resolved, checker);
  // A class, interface, namespace or interface-typed value is documented by its
  // members; recursing into a plain object literal would print data, not an API.
  const expands = kind === "class" || kind === "interface" || kind === "namespace"
    || (kind === "variable" && Boolean(type.getSymbol() ?? type.aliasSymbol) && checker.getPropertiesOfType(type).length > 0);
  const members = expands
    ? [
      ...(kind === "class" ? [constructorMember(type, checker, declaration)] : []),
      ...nestedMembers(
        kind === "class" ? type.getConstructSignatures()[0]?.getReturnType() ?? type : type,
        checker,
        declaration,
        depth
      ),
      ...(kind === "class" ? nestedMembers(type, checker, declaration, depth, true) : [])
    ].filter((member) => member !== undefined)
      .filter((member, index, all) => all.findIndex((candidate) => candidate.name === member.name) === index)
      .sort((left, right) => left.name.localeCompare(right.name))
    : [];
  return {
    name,
    kind,
    signature: clip(signature, SIGNATURE_LIMIT),
    ...(documentation ? { documentation } : {}),
    ...tagsOf(resolved, checker),
    ...(members.length ? { members } : {})
  };
}

/** One member per export of an ambient module, deduplicated by name. */
function membersOfSymbols(symbols, checker, node, depth) {
  const members = [];
  const seen = new Set();
  for (const symbol of symbols) {
    const name = symbol.getName();
    if (!usableName(name) || seen.has(name)) continue;
    seen.add(name);
    members.push(memberOf(symbol, checker, node, depth, false));
  }
  return members;
}

/**
 * The members of a module declared as `export = value`, which is how
 * `node:path`, `node:assert`, `node:module` and `node:os` are written: the module's
 * own exports are types, and the value a caller actually uses is the export
 * assignment target — a namespace, an interface-typed constant, or a callable.
 */
function exportAssignmentMembers(moduleSymbol, checker, declaration, shortName) {
  const exported = moduleSymbol.exports?.get("export=");
  if (!exported) return [];
  const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
  const node = target.valueDeclaration ?? target.declarations?.[0] ?? declaration;
  const type = checker.getTypeOfSymbolAtLocation(target, node);
  const calls = callLines(type, checker, node);
  const documentation = documentationOf(target, checker);
  const members = nestedMembers(type, checker, node, 1);
  if (calls.length) {
    members.push({
      name: shortName,
      kind: "function",
      signature: calls.map((call) => `${shortName}${call}`).join("\n"),
      ...(documentation ? { documentation } : {}),
      ...tagsOf(target, checker)
    });
  }
  return members;
}

/** A program whose only root file is empty, so the symbols in scope at that file
 * are exactly the globals the compiler options expose. */
function createGlobalsProgram(name, options) {
  const synthetic = path.join(root, "scripts", `.api-reference-${name}.d.ts`);
  const host = ts.createCompilerHost(options, true);
  host.getCurrentDirectory = () => root;
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    path.resolve(fileName) === synthetic
      ? ts.createSourceFile(fileName, "", languageVersion, true)
      : getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => path.resolve(fileName) === synthetic || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => path.resolve(fileName) === synthetic ? "" : readFile(fileName);
  const program = ts.createProgram({ rootNames: [synthetic], options, host });
  const source = program.getSourceFile(synthetic);
  if (!source) throw new Error(`The ${name} globals program has no synthetic source file.`);
  return { program, source };
}

const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.esnext.d.ts"],
  skipLibCheck: true,
  noEmit: true
};

/** The value names a program's global scope declares, in name order. */
function globalSymbols(program, source) {
  const checker = program.getTypeChecker();
  return checker.getSymbolsInScope(source, ts.SymbolFlags.Value)
    .filter((symbol) => usableName(symbol.getName()) && !SKIPPED_GLOBALS.has(symbol.getName()))
    .sort((left, right) => left.getName().localeCompare(right.getName()));
}

/** The Node built-in modules, from the ambient `node:` declarations. */
function nodeModules(program) {
  const checker = program.getTypeChecker();
  const modules = [];
  for (const symbol of checker.getAmbientModules()) {
    const id = symbol.getName().replace(/^"|"$/g, "");
    // `@types/node` re-declares every built-in under its bare name too (`fs`);
    // only the `node:` spelling is the module a user imports.
    if (!id.startsWith("node:")) continue;
    const declaration = symbol.declarations?.[0];
    if (!declaration) continue;
    const shortName = id.slice("node:".length);
    const members = [
      // A module's own exports are one level deep: a namespace export such as
      // `fs.promises` has its own module entry, so it is named here rather than
      // repeated in full inside `node:fs`.
      ...membersOfSymbols(checker.getExportsOfModule(symbol), checker, declaration, 1),
      ...exportAssignmentMembers(symbol, checker, declaration, shortName)
    ]
      .filter((member, index, all) => all.findIndex((candidate) => candidate.name === member.name) === index)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (!members.length) continue;
    const documentation = documentationOf(symbol, checker);
    modules.push({
      id,
      family: "node",
      name: shortName,
      ...(documentation ? { documentation } : {}),
      members
    });
  }
  return modules.sort((left, right) => left.id.localeCompare(right.id));
}

/** Every ECMAScript or Node global as one entry: the value itself is the single
 * member, and the members of its type (or of the instance it constructs) sit
 * inside it. */
function globalModules(program, source, family, skip) {
  const checker = program.getTypeChecker();
  const modules = [];
  for (const symbol of globalSymbols(program, source)) {
    if (skip.has(symbol.getName())) continue;
    const node = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!node) continue;
    modules.push({
      id: family === "js" ? `js.${symbol.getName()}` : symbol.getName(),
      family,
      name: symbol.getName(),
      members: [memberOf(symbol, checker, node, MEMBER_DEPTH, false)]
    });
  }
  return modules.sort((left, right) => left.id.localeCompare(right.id));
}

/** The whole catalog, sorted by id so a regeneration is byte-identical. */
export function buildApiReference() {
  const js = createGlobalsProgram("js", { ...COMPILER_OPTIONS, types: [], typeRoots: [] });
  const node = createGlobalsProgram("node", {
    ...COMPILER_OPTIONS,
    types: ["node"],
    typeRoots: [path.join(root, "node_modules", "@types")]
  });
  const jsModules = globalModules(js.program, js.source, "js", new Set());
  // @types/node declares the ECMAScript globals it relies on too, so the JS
  // program is the authority for what belongs to `js`.
  const nodeModulesAll = [
    ...nodeModules(node.program),
    ...globalModules(node.program, node.source, "node", new Set(jsModules.map((module) => module.name)))
  ];
  return {
    version: API_REFERENCE_VERSION,
    typescript: ts.version,
    modules: [...nodeModulesAll, ...jsModules].sort((left, right) => left.id.localeCompare(right.id))
  };
}

/** The shipped catalog text. One line, so `--check` compares exact bytes. */
export async function buildApiReferenceText() {
  const catalog = buildApiReference();
  if (!catalog.modules.length) throw new Error("The API reference catalog is empty.");
  return `${JSON.stringify(catalog)}\n`;
}

export async function writeApiReference(text) {
  const content = text ?? await buildApiReferenceText();
  await mkdir(path.dirname(API_REFERENCE_PATH), { recursive: true });
  await writeFile(API_REFERENCE_PATH, content, "utf8");
  return API_REFERENCE_PATH;
}

function sameText(current, expected) {
  return current.replace(/\r\n/g, "\n") === expected;
}

async function runCli(argv) {
  if (argv.includes("--check")) {
    let existing;
    try {
      existing = await readFile(API_REFERENCE_PATH, "utf8");
    } catch {
      console.error("dist/api-reference.json is missing. Run `npm run build`.");
      process.exitCode = 1;
      return;
    }
    const expected = await buildApiReferenceText();
    if (!sameText(existing, expected)) {
      console.error("The shipped API reference is out of date. Run `npm run build`.");
      process.exitCode = 1;
      return;
    }
    console.log("The shipped API reference is up to date.");
    return;
  }
  const file = await writeApiReference();
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2));
}
