/**
 * The Dext TypeScript declaration surface.
 *
 * Dext runs plain TypeScript in a long-lived Node child process (the kernel).
 * User code imports the built-in APIs from the `dext` module, so the editor and
 * `tsc` need a declaration for that module. This module builds it from the same
 * registry the runtime executes (`BUILTIN_METHODS`) and the shared result-shape
 * catalog (`builtinTypeDefinitions`), so a signature or a result field can never
 * drift away from what the kernel actually offers.
 *
 * Nothing here imports VS Code: the generator is executed by
 * `scripts/generateDextTypes.mjs` in plain Node, and the same text is injected
 * into Monaco's TypeScript worker.
 *
 * Every value that crosses a `dext` API boundary must be JSON-serializable: the
 * kernel and the extension host exchange JSON, so `Map`, `Set`, `Buffer`,
 * functions and reference cycles cannot be sent, and a `Date` becomes an ISO
 * string. The generated declaration says so in its own comments.
 */
import { BUILTIN_METHODS } from "./builtins.js";
import { builtinTypeDefinition, type BuiltinTypeDefinition } from "./builtinTypeDefinitions.js";
import { CONVERSATION_METHODS, methodResultType } from "./methodSignature.js";
import type { CallableDefinition, FieldDefinition } from "./types.js";

/** The bare module specifier user code imports. */
export const DEXT_MODULE_NAME = "dext";
/**
 * Declarations the workspace-independent part lives under, inside Dext's own
 * storage. The extension writes this file once and points every workspace at it,
 * so a project never carries its own copy of the generated API surface.
 */
export const DEXT_DECLARATION_DIRECTORY = "dext";
export const DEXT_DECLARATION_FILE = "dext.d.ts";
/** Workspace-relative (inside `.dext`) path of a workspace-local declaration. */
export const DEXT_TYPES_PATH = "api/dext.d.ts";
/** Workspace-relative path of the directory a workspace's own APIs live in. */
export const DEXT_API_DIRECTORY = ".dext/api";
/** Workspace-relative (inside `.dext`) path of the generated project file. */
export const DEXT_TSCONFIG_PATH = "tsconfig.json";
/** The generated project's manifest: it marks the project as ESM, matching how the
 * kernel loads it, and declares the type definitions its API files compile against. */
export const DEXT_PACKAGE_PATH = "package.json";

const BOUNDARY_NOTE =
  "Import a result type when you annotate a return value: they are exported by this\n" +
  "module, not declared globally, so `export async function main(): Promise<AskResult>`\n" +
  "needs `import { ask, type AskResult } from \"dext\";`.\n" +
  "\n" +
  "Values that cross a `dext` API boundary must be JSON-serializable. The kernel and the\n" +
  "extension host exchange JSON, so `Map`, `Set`, `Buffer`, functions and reference cycles\n" +
  "cannot be sent; a `Date` becomes an ISO string.";

/** Static result shapes that the registry does not declare as an API output. */
const SUPPORTING_TYPE_NAMES: readonly string[] = [
  "CodeRef",
  "PatchChange",
  "Range",
  "Position",
  "ui.Option",
  "ui.Action",
  "ui.Field",
  "UiFieldAnswer",
  "agent.ModelOptions"
];

/** Identifiers that are never a generated type name. */
const NON_TYPE_NAMES = new Set([
  "list", "dict", "str", "bool", "float", "int",
  "string", "number", "boolean", "object", "unknown", "Record",
  "None", "undefined", "null", "void", "never", "true", "false"
]);

function capitalize(name: string): string {
  return name.length ? name[0]!.toUpperCase() + name.slice(1) : name;
}

/** Split `source` on `separator` where it appears outside quotes and brackets.
 * Field types arrive as compact strings (`string | (number; boolean)[]`), so the
 * generator needs the top-level pieces without pulling in a parser. */
function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/** Turn a namespaced shape name (`ui.Field`, `agent.ModelOptions`) into one identifier. */
export function dextTypeName(name: string): string {
  return name.split(".").map(capitalize).join("");
}

/** Strip characters that would break a generated comment. */
function commentText(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\*\//g, "*\\/").trim();
}

function parenthesesNeeded(type: string): boolean {
  return splitTopLevel(type, "|").length > 1;
}

function arrayOf(element: string): string {
  return parenthesesNeeded(element) ? `(${element})[]` : `${element}[]`;
}

/** Render one `name?: type` member of an inline shape. */
function dextTsMember(member: string): string {
  const match = /^([A-Za-z_]\w*)(\?)?:\s*([\s\S]+)$/.exec(member.trim());
  if (!match) return "";
  return `${match[1]}${match[2] ? "?" : ""}: ${dextTsType(match[3]!)}`;
}

/**
 * Translate a type expression from the registry's signature notation (`list[T]`,
 * `dict[str, T]`, `ui.Field`, `T | U`) into valid TypeScript.
 */
export function dextTsType(type: string): string {
  const value = type.trim();
  const union = splitTopLevel(value, "|");
  if (union.length > 1) return union.map((part) => dextTsType(part.trim())).join(" | ");
  if (value.startsWith("list[") && value.endsWith("]")) return arrayOf(dextTsType(value.slice("list[".length, -1)));
  if (value.startsWith("dict[") && value.endsWith("]")) {
    const parts = splitTopLevel(value.slice("dict[".length, -1), ",");
    return `Record<${dextTsType(parts[0]?.trim() ?? "string")}, ${dextTsType(parts[1]?.trim() ?? "unknown")}>`;
  }
  if (value.endsWith("[]")) return arrayOf(dextTsType(value.slice(0, -2)));
  if (value.startsWith("{") && value.endsWith("}")) {
    const inner = value.slice(1, -1);
    const separator = splitTopLevel(inner, ";").length > 1 ? ";" : ",";
    const members = splitTopLevel(inner, separator).map(dextTsMember).filter(Boolean);
    return members.length ? `{ ${members.join("; ")} }` : "Record<string, never>";
  }
  if (/^"[^"]*"$/.test(value)) return value;
  if (/^'[^']*'$/.test(value)) return `"${value.slice(1, -1)}"`;
  if (value === "str") return "string";
  if (value === "bool") return "boolean";
  if (value === "float" || value === "int") return "number";
  if (value === "None") return "undefined";
  if (value === "object") return "Record<string, unknown>";
  if (value.includes(".")) return dextTypeName(value);
  return value;
}

function dextTsScalar(type: FieldDefinition["type"], field: FieldDefinition): string {
  switch (type) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "enum":
      return field.values?.length ? field.values.map((value) => JSON.stringify(value)).join(" | ") : "string";
    case "object":
      if (field.shapeType) return dextTsType(field.shapeType);
      if (field.properties?.length) {
        const properties = field.properties.map((property) =>
          `${property.name}${property.required ? "" : "?"}: ${dextTsFieldType(property)}`);
        return `{ ${properties.join("; ")} }`;
      }
      return "Record<string, unknown>";
    case "list":
      return field.items ? arrayOf(dextTsScalar(field.items.type, field.items)) : "unknown[]";
    case "context": return "ContextReference";
    case "dir": return "DirectoryReference | DirRef";
    case "result": return "DextResult";
  }
}

/** Render the accepted TypeScript type of one API argument. */
export function dextTsFieldType(field: FieldDefinition): string {
  const types = [field.type, ...(field.accepts ?? [])].map((type) => dextTsScalar(type, field));
  const scalar = [...new Set(types)].join(" | ");
  if (!field.multiple) return scalar;
  return `${scalar} | ${arrayOf(scalar)}`;
}

/** The single object of named arguments every Dext API takes. An `internal` field is
 * runtime-only — except the `skills` and `rules` a conversation method takes per call,
 * which are options a caller writes and every other surface already documents. */
export function dextOptionsType(method: CallableDefinition): string {
  const fields = method.input.filter((field) => !field.internal || CONVERSATION_METHODS.has(method.id));
  if (!fields.length) return "Record<string, never>";
  const members = fields.map((field) => `${field.name}${field.required ? "" : "?"}: ${dextTsFieldType(field)}`);
  return `{ ${members.join("; ")} }`;
}

function extractTypeNames(type: string): string[] {
  const names: string[] = [];
  for (const match of type.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    if (!NON_TYPE_NAMES.has(match[0])) names.push(match[0]);
  }
  return names;
}

function collectFieldRoots(field: FieldDefinition, roots: string[]): void {
  if (field.shapeType) roots.push(field.shapeType);
  if (field.resultType) roots.push(field.resultType);
  if (field.items) collectFieldRoots(field.items, roots);
  for (const property of field.properties ?? []) collectFieldRoots(property, roots);
  if (field.discriminator) {
    for (const variant of field.discriminator.variants) {
      for (const property of variant.properties) collectFieldRoots(property, roots);
    }
  }
}

function shapeRoots(): string[] {
  const roots: string[] = [];
  for (const method of BUILTIN_METHODS) {
    roots.push(methodResultType(method));
    for (const field of method.input) collectFieldRoots(field, roots);
    for (const field of method.output.fields ?? []) collectFieldRoots(field, roots);
  }
  roots.push(...SUPPORTING_TYPE_NAMES);
  return [...new Set(roots)];
}

/** Follow every shape reference transitively so the document declares a closed set. */
function collectCatalogTypes(roots: readonly string[]): BuiltinTypeDefinition[] {
  const found = new Map<string, BuiltinTypeDefinition>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift()!;
    if (found.has(name)) continue;
    const definition = builtinTypeDefinition(name);
    if (!definition) continue;
    found.set(name, definition);
    for (const field of definition.fields) queue.push(...extractTypeNames(field.type));
  }
  return [...found.values()];
}

function renderInterface(definition: BuiltinTypeDefinition): string {
  const name = dextTypeName(definition.name);
  const members = definition.fields.map((field) => {
    const description = field.description ? ` // ${commentText(field.description)}` : "";
    return `  ${field.name}${field.optional ? "?" : ""}: ${dextTsType(field.type)};${description}`;
  });
  return [
    `/** ${commentText(definition.description)} */`,
    `export interface ${name} {`,
    ...members,
    `}`
  ].join("\n");
}

/** Names the manual blocks declare, so an MCP result type cannot collide with one. */
const MANUAL_TYPE_NAMES = ["PatchResult", "McpRawResult", "DirectoryReference", "DirRef", "ContextReference", "DextResult"] as const;

function renderManualTypes(extraResultTypes: readonly string[]): string[] {
  const resultTypes = [...new Set([...BUILTIN_METHODS.map((method) => methodResultType(method)), ...extraResultTypes])];
  return [
    [
      "/** One applicable patch. No API returns one directly: this is the shape of",
      " * `AgentResult.patch` and of a turn review's changes. */",
      "export interface PatchResult {",
      '  kind: "patch";',
      "  title: string;",
      "  changes: PatchChange[];",
      "}"
    ].join("\n"),
    [
      "/** Raw result of an MCP `tools/call` request. */",
      "export interface McpRawResult {",
      '  kind: "mcpRaw";',
      "  server: string;",
      "  tool: string;",
      "  content?: string;",
      "  structured?: Record<string, unknown>;",
      "}"
    ].join("\n"),
    [
      "/** A workspace-relative directory reference. */",
      "export interface DirectoryReference {",
      '  kind: "dir";',
      "  path: string;",
      "}"
    ].join("\n"),
    [
      "/** A resolved directory reference produced by the host. */",
      "export interface DirRef {",
      '  kind: "dirRef";',
      "  uri: string;",
      "  path: string;",
      "}"
    ].join("\n"),
    [
      "/** An inline editor reference accepted where a `context` value is expected. */",
      "export type ContextReference =",
      '  | { kind: "selection" }',
      '  | { kind: "activeFile" }',
      '  | { kind: "file"; path: string }',
      '  | { kind: "symbol"; name: string };'
    ].join("\n"),
    [
      "/** Every value a Dext API can return. */",
      `export type DextResult = ${[...resultTypes, "McpRawResult"].join(" | ")};`
    ].join("\n")
  ];
}

/**
 * A result interface generated from a runtime field definition rather than from the
 * static catalog. MCP tools are declared by a workspace's own manifest, so their
 * protected result shape arrives as `FieldDefinition`s.
 */
interface GeneratedType {
  name: string;
  description: string;
  fields: readonly FieldDefinition[];
}

/**
 * The extra methods, one per id.
 *
 * A directory reachable under two spellings would otherwise declare the same tool
 * twice, which emits a duplicate member. The first declaration wins, matching the
 * loader and the runtime, where an id resolves to exactly one method.
 */
function extraMethods(methods: readonly CallableDefinition[]): CallableDefinition[] {
  const byId = new Map<string, CallableDefinition>();
  for (const method of methods) if (!byId.has(method.id)) byId.set(method.id, method);
  return [...byId.values()];
}

/** Render one generated interface the same way `renderInterface` renders a catalog one. */
function renderGeneratedInterface(definition: GeneratedType): string {
  const members = definition.fields.map((field) => {
    const description = field.description ? ` // ${commentText(field.description)}` : "";
    return `  ${field.name}${field.required ? "" : "?"}: ${dextTsFieldType(field)};${description}`;
  });
  return [
    `/** ${commentText(definition.description)} */`,
    `export interface ${definition.name} {`,
    ...members,
    `}`
  ].join("\n");
}

/** An identifier-safe form of a method id, for qualifying a colliding type name
 * (`mcp.a.b-c` → `McpABC`). */
function identifierSuffix(id: string): string {
  return id.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

/**
 * A unique type name for one tool.
 *
 * The runtime names a tool's result from its server and tool, and those names can
 * collide: `a-b` + `c` and `a` + `b-c` both render `ABCResult`, and a built-in name is
 * never available. Sharing one interface between two tools would describe the wrong
 * fields, and a name that does not start with a letter (`1` + `2` → `12Result`) is not
 * an identifier at all, so a colliding or unsafe name is qualified with the tool id.
 * The manifests decide the order, so the result stays deterministic.
 */
function uniqueTypeName(preferred: string, methodId: string, taken: ReadonlySet<string>): string {
  const safe = /^[A-Za-z_$]/.test(preferred) ? preferred : `Mcp${preferred}`;
  if (!taken.has(safe)) return safe;
  const qualified = `${safe}${identifierSuffix(methodId)}`;
  let name = qualified;
  for (let index = 2; taken.has(name); index += 1) name = `${qualified}${index}`;
  return name;
}

/**
 * The result interfaces the extra (MCP) methods contribute, and which of them each
 * tool returns — one interface per tool that declares an output schema, and nothing
 * for a tool that declares none (the runtime answers those with `McpRawResult`).
 */
interface GeneratedTypes {
  types: GeneratedType[];
  resultByMethod: Map<string, string>;
}

function generatedTypes(methods: readonly CallableDefinition[], reserved: ReadonlySet<string>): GeneratedTypes {
  const taken = new Set(reserved);
  const types = new Map<string, GeneratedType>();
  const resultByMethod = new Map<string, string>();
  for (const method of methods) {
    const preferred = method.output.resultType;
    if (!preferred || !method.output.fields?.length) continue;
    const name = uniqueTypeName(preferred, method.id, taken);
    taken.add(name);
    if (!types.has(name)) {
      types.set(name, {
        name,
        description: method.output.description ?? `Result returned by ${method.id}.`,
        // The runtime result carries its kind alongside the schema's fields (the
        // adapter adds it), so the interface has to declare it or the union in
        // `DextResult` cannot be narrowed.
        fields: [
          { name: "kind", type: "enum", values: [method.output.kind], required: true },
          ...method.output.fields
        ]
      });
    }
    resultByMethod.set(method.id, name);
  }
  return {
    types: [...types.values()].sort((left, right) => left.name.localeCompare(right.name)),
    resultByMethod
  };
}

/** Every name the built-in document declares, so a generated type cannot shadow one. */
function declaredTypeNames(): Set<string> {
  return new Set([
    ...collectCatalogTypes(shapeRoots()).map((definition) => dextTypeName(definition.name)),
    ...BUILTIN_METHODS.map((method) => methodResultType(method)),
    ...MANUAL_TYPE_NAMES
  ]);
}

/** A property name as written in the generated object type. */
function propertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** The contract a manifest declares for one tool, kept in the hover text because the
 * argument object itself is typed as `Record<string, unknown>` (see `renderMcp`). */
function toolDocumentation(method: CallableDefinition): string {
  const arguments_ = method.input
    .filter((field) => !field.internal)
    .map((field) => `${field.name}${field.required ? "" : "?"}: ${dextTsFieldType(field)}`);
  return [
    "/**",
    ` * ${commentText(method.description)}`,
    ` * Arguments: ${arguments_.length ? commentText(arguments_.join(", ")) : "none"}`,
    " */"
  ].join("\n");
}

/**
 * One node of the `mcp` tree: the path segment that names it, the tool registered at
 * exactly that path (when an id ends there), and the segments below it.
 */
interface McpNode {
  method?: CallableDefinition;
  children: Map<string, McpNode>;
}

/**
 * The `mcp` group, as the tree the runtime itself walks.
 *
 * `mcp.<server>.<tool>` is how user code calls a tool, and the kernel resolves that
 * call by joining the property names it was reached through — so the declaration is
 * nested by the id's own segments and the natural spelling is the one that is typed:
 * `mcp.docs.read`, and a tool the manifest named `b.c` is `mcp.docs.b.c`. A node that
 * is both a tool and a step (`b` next to `b.c`) carries a call signature and its
 * children. A segment that is not an identifier (`teambition-user`, `list-tasks`)
 * cannot be written with dots at all, so it is quoted and reached with brackets.
 *
 * Every tool returns the interface its manifest declares. The argument object stays
 * `Record<string, unknown>`: its parameters cannot be narrowed while the same
 * declaration keeps a globally configured server callable (an index signature beside
 * a narrower member is TS2411). Each tool's argument contract therefore rides its own
 * documentation comment, and the runtime validates the call and names the offending
 * argument.
 *
 * The floor is a separate object type rather than an index signature on the tree —
 * a nested member cannot satisfy an index signature in the same type — and it is
 * recursive, because a globally configured server is walked segment by segment too.
 * Unknown segments therefore resolve to `DextResult` and fail at runtime with the
 * name of the method, which is the same shape a project without manifests sees.
 */
function renderMcp(methods: readonly CallableDefinition[], resultByMethod: ReadonlyMap<string, string>): string {
  const roots = mcpTree(methods);
  if (!roots.size) {
    return [
      "/**",
      " * `mcp.<server>.<tool>` — call a configured MCP tool. Servers and tools are",
      " * configured per project, so the proxy is declared by index signature.",
      " */",
      "export const mcp: { [server: string]: { [tool: string]: (options?: Record<string, unknown>) => Promise<McpRawResult> } };"
    ].join("\n");
  }
  const members: string[] = [...roots]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([segment, node]) => renderMcpMember(segment, node, "  ", resultByMethod));
  return [
    "/**",
    " * `mcp.<server>.<tool>` — call a configured MCP tool. The servers this project's",
    " * manifests declare are typed below; a globally configured server is walked the",
    " * same way and returns `DextResult`.",
    " */",
    "type McpTool = ((options?: Record<string, unknown>) => Promise<DextResult>) & { [segment: string]: McpTool };",
    "export const mcp: { [server: string]: McpTool } & {",
    ...members,
    "};"
  ].join("\n");
}

/** The tree of every declared tool, keyed by the id's own segments. */
function mcpTree(methods: readonly CallableDefinition[]): Map<string, McpNode> {
  const roots = new Map<string, McpNode>();
  for (const method of methods) {
    const segments = method.id.split(".").slice(1);
    if (!segments.length || segments.some((segment) => !segment)) continue;
    let level = roots;
    let node: McpNode | undefined;
    for (const segment of segments) {
      node = level.get(segment) ?? { children: new Map() };
      level.set(segment, node);
      level = node.children;
    }
    if (node) node.method = method;
  }
  return roots;
}

/**
 * One member of the tree: a leaf is `key(options?): Promise<Result>;`, and a node
 * with children is an object type — with a call signature first when the node is also
 * a tool. Every member of a node sorts by name, so the output is deterministic.
 */
function renderMcpMember(
  segment: string,
  node: McpNode,
  indent: string,
  resultByMethod: ReadonlyMap<string, string>
): string[] {
  const key = propertyName(segment);
  const result = node.method ? resultByMethod.get(node.method.id) ?? "McpRawResult" : "DextResult";
  const signature = `(options?: Record<string, unknown>): Promise<${result}>;`;
  const documentation = node.method ? indentBlock(toolDocumentation(node.method), indent) : undefined;
  if (!node.children.size) return [...(documentation ? [documentation] : []), `${indent}${key}${signature}`];
  const body: string[] = [];
  if (documentation) body.push(documentation, `${indent}  ${signature}`);
  for (const [child, grandchild] of [...node.children].sort(([left], [right]) => left.localeCompare(right))) {
    body.push(...renderMcpMember(child, grandchild, `${indent}  `, resultByMethod));
  }
  return [`${indent}${key}: {`, ...body, `${indent}};`];
}

function indentBlock(value: string, indent: string): string {
  const lines = value.replace(/\n$/, "").split("\n");
  return lines.map((line) => (line.length ? `${indent}${line}` : line)).join("\n");
}

/**
 * The result-type declarations, derived from `BUILTIN_METHODS` and
 * `builtinTypeDefinitions`. The output is deterministic: manual supporting types
 * come first in a fixed order, then every catalog shape sorted by name, then the
 * shapes a project's own MCP manifests declare.
 */
export function dextTypesDocument(methods: readonly CallableDefinition[] = []): string {
  return renderTypesDocument(generatedTypes(extraMethods(methods), declaredTypeNames()));
}

/** The document for a surface whose generated types are already computed, so a
 * caller that needs the per-tool result names does not compute them twice. */
function renderTypesDocument(generated: GeneratedTypes): string {
  const definitions = collectCatalogTypes(shapeRoots())
    .sort((left, right) => dextTypeName(left.name).localeCompare(dextTypeName(right.name)));
  const blocks = [
    ...renderManualTypes(generated.types.map((type) => type.name)),
    ...definitions.map(renderInterface),
    ...generated.types.map(renderGeneratedInterface)
  ];
  return `${blocks.join("\n\n")}\n`;
}

function renderFunction(method: CallableDefinition): string {
  const documentation = `/** ${commentText(method.title)} — ${commentText(method.description)} */`;
  return `${documentation}\nexport function ${method.id}(options: ${dextOptionsType(method)}): Promise<${methodResultType(method)}>;`;
}

function renderUiGroup(): string {
  const methods = BUILTIN_METHODS.filter((method) => method.id.startsWith("ui."));
  const members = methods.map((method) => {
    const action = method.id.slice("ui.".length);
    return `  /** ${method.id} — ${commentText(method.description)} */\n  ${action}(options: ${dextOptionsType(method)}): Promise<${methodResultType(method)}>;`;
  });
  return [
    "/** Interactive questions. The run waits here until the user answers. */",
    "export const ui: {",
    ...members,
    "};"
  ].join("\n");
}

/**
 * The `declare module "dext"` block. It embeds the result-type declarations and
 * then declares every built-in API as a function that takes one object of named
 * arguments and returns a promise.
 *
 * `methods` are the project's own MCP tools: they are named in the `mcp` group so the
 * editor knows what that workspace can call and what each call returns.
 */
export function dextModuleDeclaration(methods: readonly CallableDefinition[] = []): string {
  const declared = extraMethods(methods);
  const generated = generatedTypes(declared, declaredTypeNames());
  const body: string[] = [];
  let uiEmitted = false;
  for (const method of BUILTIN_METHODS) {
    if (method.id.startsWith("ui.")) {
      if (!uiEmitted) { body.push(renderUiGroup()); uiEmitted = true; }
      continue;
    }
    body.push(renderFunction(method));
  }
  body.push(renderMcp(declared, generated.resultByMethod));
  const lines = [
    `declare module "${DEXT_MODULE_NAME}" {`,
    indentBlock(`/**\n * ${BOUNDARY_NOTE.replace(/\n/g, "\n * ")}\n */`, "  "),
    "",
    indentBlock(renderTypesDocument(generated), "  "),
    "",
    indentBlock(body.join("\n\n"), "  "),
    "}"
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The `paths` candidates for every directory `dext/api/<id>` resolves against, seen
 * from the generated project inside `.dext`.
 *
 * A directory the project configured lives in the workspace, so it can be named
 * relatively and stays portable; an absolute path, one that climbs out of the
 * workspace, and one inside `.dext` that holds no APIs are skipped, because a
 * committed file cannot carry them. Nothing here covers a machine-local source such
 * as the `dext.apiDirs` setting or an API in Dext's own storage: those are not part
 * of the workspace, and mapping one would make the file machine-specific.
 */
function apiPathCandidates(apiDirs: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const directory of apiDirs) {
    const relative = directory.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!relative || relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.split("/").includes("..")) continue;
    const inside = relative === ".dext" ? "" : relative.startsWith(".dext/") ? relative.slice(".dext/".length) : undefined;
    if (inside === "") continue;
    const base = inside === undefined ? `../${relative}` : `./${inside}`;
    for (const extension of ["*.ts", "*.mts", "*/index.ts"]) candidates.add(`${base}/${extension}`);
  }
  return [...candidates];
}

/**
 * The `.dext/tsconfig.json` project text. It pins the compiler options the kernel
 * and the editor rely on and maps the `dext` specifier at the declaration that ships
 * beside it.
 *
 * `dext/api/*` mirrors the kernel loader's own search order (`dextLoader.mjs`):
 * `dext/api/team/analyze` names `api/team/analyze.ts`, and a directory the project
 * adds to `apiDirs` is searched too. The substitution has to carry the extension:
 * the project resolves modules the way Node does (`moduleResolution: nodenext`),
 * which never guesses a missing extension, so a bare `./api/*` target resolves to
 * nothing and every `dext/api/...` import is a `Cannot find module` error.
 */
export function dextTsconfig(
  declarationPath: string = `./${DEXT_TYPES_PATH}`,
  apiDirs: readonly string[] = [DEXT_API_DIRECTORY]
): string {
  const config = {
    compilerOptions: {
      strict: true,
      module: "nodenext",
      moduleResolution: "nodenext",
      target: "es2022",
      noEmit: true,
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      types: [],
      paths: {
        [DEXT_MODULE_NAME]: [declarationPath],
        "dext/api/*": apiPathCandidates(apiDirs)
      }
    },
    include: ["api/**/*.ts"]
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** The declaration a workspace without its own manifests maps `dext` at: a pure
 * function of the built-in registry, so the extension stores one copy. */
export function dextSharedDeclaration(): string {
  return dextModuleDeclaration();
}

/**
 * The `@types/node` range the generated project declares, pinned to the Node major the
 * kernel runs — Electron's bundled Node for the oldest VS Code this extension supports —
 * so the declarations cannot describe an API that runtime does not have.
 */
const DEXT_NODE_TYPES = "^22";

/**
 * The initial `.dext/package.json`, owned by the workspace after creation.
 *
 * The ESM marker is what lets tsserver accept the top-level `await` the kernel supports.
 * APIs import `node:` built-ins with ordinary imports. Seed their type definitions,
 * then let the project maintain dependencies, versions and scripts itself.
 */
const DEXT_PACKAGE_MANIFEST = {
  type: "module",
  devDependencies: { "@types/node": DEXT_NODE_TYPES }
};

/**
 * The generated project a workspace commits: the declaration beside its APIs, the
 * `paths` project that maps `dext` at it, and the manifest.
 *
 * A relative mapping is what makes the files portable. `.dext/package.json` marks
 * the directory as ESM; without it tsserver treats `.dext/api/*.ts` as CommonJS and
 * rejects the top-level `await` the kernel supports, so the editor would disagree
 * with the runtime about the same file. It also declares the Node type definitions a
 * workspace needs before an API file that imports a `node:` built-in can type-check:
 * `types: []` in the generated project keeps `@types/node`'s ambient modules out of the
 * program until the file references them, so such a file carries
 * `/// <reference types="node" />` and the dependency is installed once with
 * `npm install` in `.dext`.
 *
 * `methods` are the project's own MCP tools. They are part of the declaration
 * because the workspace has the manifests that declare them, which keeps the file a
 * function of what is committed — a global manifest lives on one machine and would
 * make the file differ from a teammate's.
 *
 * `apiDirs` are the workspace-relative directories `dext/api/<id>` resolves against,
 * so an API the project keeps outside `.dext/api` is still addressable.
 */
export function dextFiles(
  methods: readonly CallableDefinition[] = [],
  apiDirs: readonly string[] = [DEXT_API_DIRECTORY]
): { path: string; content: string; createOnly?: boolean }[] {
  return [
    { path: DEXT_TYPES_PATH, content: dextModuleDeclaration(methods) },
    { path: DEXT_TSCONFIG_PATH, content: dextTsconfig(undefined, apiDirs) },
    { path: DEXT_PACKAGE_PATH, content: `${JSON.stringify(DEXT_PACKAGE_MANIFEST, null, 2)}\n`, createOnly: true }
  ];
}
