import { parse as parseJson } from "jsonc-parser/lib/esm/main.js";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import type * as TreeSitter from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import { z } from "zod";
import { parserFor } from "../../../../platform/node/syntaxParser.js";
import { buildStructureGraph, rankStructureFiles, type StructureGraph } from "./projectStructureGraph.js";

// Bump when extraction, grouping or resolution changes. Cached facts never contain source bodies.
export const PROJECT_STRUCTURE_VERSION = 4;
const visibilitySchema = z.enum(["public", "protected", "package", "private"]);
const symbolSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.string(),
  line: z.number().int().positive(),
  signature: z.string(),
  ownerId: z.string().optional(),
  ownerName: z.string().optional(),
  memberKind: z.enum(["method", "field"]).optional(),
  typeText: z.string().optional(),
  parameters: z.string().optional(),
  returns: z.string().optional(),
  visibility: visibilitySchema.optional(),
  static: z.boolean().optional(),
  abstract: z.boolean().optional(),
  extends: z.array(z.string()).optional(),
  implements: z.array(z.string()).optional()
});
export type StructureSymbol = z.infer<typeof symbolSchema>;
const importSchema = z.object({ specifier: z.string(), line: z.number().int().positive(), kind: z.enum(["import", "module", "dynamic"]), typeOnly: z.boolean().optional() });
const fileSchema = z.object({ path: z.string(), hash: z.string(), language: z.string(), lines: z.number(), errors: z.boolean(), symbols: z.array(symbolSchema), imports: z.array(importSchema) });
export const structureCacheSchema = z.object({ version: z.literal(PROJECT_STRUCTURE_VERSION), files: z.array(fileSchema) });
export type StructureFile = z.infer<typeof fileSchema>;
export type StructureCache = z.infer<typeof structureCacheSchema>;
export interface StructureDependency { from: string; specifier: string; line: number; kind: "import" | "module" | "dynamic"; status: "resolved" | "unresolved"; to?: string; typeOnly?: boolean | undefined }
export interface StructureModule {
  id: string; path: string; package: string; languages: string[]; files: number;
  entryPoints: string[]; symbols: Array<StructureSymbol & { path: string }>;
  evidence: Array<{ path: string; contentHash: string }>;
  references: Array<{ specifier: string; status: "resolved" | "unresolved"; count: number }>;
  dependsOn: string[]; dependencyCount: number; unresolved: number; hash: string;
  /** Complete file-level facts, independent of the representative directory summary above. */
  members: StructureMember[];
}
export interface StructureMember {
  path: string; hash: string; language: string; lines: number; symbols: StructureFile["symbols"];
  dependencies: Array<{ specifier: string; to?: string; typeOnly?: boolean }>;
}
export interface StructureSummary {
  version: 2; hash: string; files: number; parsed: number; cached: number; failed: number; unsupported: number;
  modules: StructureModule[];
  issues: Array<{ path: string; reason: string }>;
}
export interface StructureIndex { cache: StructureCache; dependencies: StructureDependency[]; summary: StructureSummary; graph: StructureGraph }
export interface StructureInput { path: string; content?: string; issue?: string }

const structureSymbolSchema = z.object({ path: z.string(), ...symbolSchema.shape });
const structureMemberSchema = z.object({
  path: z.string(), hash: z.string(), language: z.string(), lines: z.number(), symbols: z.array(symbolSchema),
  dependencies: z.array(z.object({ specifier: z.string(), to: z.string().optional(), typeOnly: z.boolean().optional() }))
});
const structureModuleSchema = z.object({
  id: z.string(), path: z.string(), package: z.string(), languages: z.array(z.string()), files: z.number(),
  entryPoints: z.array(z.string()), symbols: z.array(structureSymbolSchema),
  evidence: z.array(z.object({ path: z.string(), contentHash: z.string() })),
  references: z.array(z.object({ specifier: z.string(), status: z.enum(["resolved", "unresolved"]), count: z.number() })),
  dependsOn: z.array(z.string()), dependencyCount: z.number(), unresolved: z.number(), hash: z.string(),
  members: z.array(structureMemberSchema)
});
/** The persisted summary shape a bounded read may reuse without reparsing sources. */
export const structureSummarySchema = z.object({
  version: z.literal(2), hash: z.string(), files: z.number(), parsed: z.number(), cached: z.number(), failed: z.number(), unsupported: z.number(),
  modules: z.array(structureModuleSchema),
  issues: z.array(z.object({ path: z.string(), reason: z.string() }))
});

export function structureLanguage(path: string): string | undefined {
  if (/\.tsx$/i.test(path)) return "tsx";
  if (/\.(?:ts|mts|cts)$/i.test(path)) return "typescript";
  if (/\.(?:js|jsx|mjs|cjs)$/i.test(path)) return "javascript";
  if (/\.rs$/i.test(path)) return "rust";
  if (/\.py$/i.test(path)) return "python";
  return undefined;
}
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const unquote = (value: string): string => value.replace(/^["']|["']$/g, "");
const symbolId = (path: string, name: string, line: number): string => `${path}#${name}@${line}`;
const typeName = (value: string): string => value.trim().replace(/<[\s\S]*$/, "").split("::").at(-1)?.split(".").at(-1)?.trim() ?? value.trim();
const typeAnnotation = (value: string | undefined): string | undefined => {
  const text = value?.replace(/^\s*:\s*/, "").trim();
  return text ? text : undefined;
};
function parametersText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let text = value.trim().replace(/^\(/, "").replace(/\)$/, "").trim();
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  while (parts.length && /^(?:&\s*(?:mut\s+)?self|mut\s+self|self)$/.test(parts[0]!)) parts.shift();
  text = parts.join(", ");
  return text || undefined;
}
function visibilityOf(node: Node): "public" | "protected" | "package" | "private" | undefined {
  const text = node.namedChildren.find((child) => child.type === "accessibility_modifier" || child.type === "visibility_modifier")?.text;
  if (!text) return undefined;
  if (text === "public" || text === "pub" || text.startsWith("pub(")) return "public";
  if (text === "protected") return "protected";
  if (text === "private") return "private";
  return text === "package" ? "package" : undefined;
}
function hasToken(node: Node, token: string): boolean {
  return node.children.some((child) => child.type === token);
}
function signatureOf(content: string, node: Node): string {
  const body = node.childForFieldName("body") ?? node.childForFieldName("value")?.childForFieldName("body");
  return content.slice(node.startIndex, Math.min(body?.startIndex ?? node.endIndex, node.startIndex + 200)).replace(/\s+/g, " ").trim();
}

function extract(parser: TreeSitter.Parser, path: string, content: string, language: string): StructureFile {
  const tree = parser.parse(content);
  if (!tree) throw new Error("Parser returned no syntax tree");
  const symbols: StructureFile["symbols"] = [], imports: StructureFile["imports"] = [];
  const addImport = (node: Node, specifier: string, kind: "import" | "module" | "dynamic" = "import", typeOnly = false) => {
    if (specifier) imports.push({ specifier, line: node.startPosition.row + 1, kind, ...(typeOnly ? { typeOnly } : {}) });
  };
  const addSymbol = (node: Node, nameNode: Node, extra: Omit<StructureSymbol, "id" | "name" | "kind" | "line" | "signature"> = {}): string => {
    const line = node.startPosition.row + 1;
    const id = symbolId(path, nameNode.text, line);
    symbols.push({ id, name: nameNode.text, kind: node.type, line, signature: signatureOf(content, node), ...extra });
    return id;
  };
  interface TypeScope { id: string; name: string; kind: string }
  const declarations = /^(?:function_declaration|generator_function_declaration|method_definition|method_signature|function_item|function_signature_item|function_definition|variable_declarator)$/;
  const typeDeclarations: Record<string, string> = {
    class_declaration: "class", abstract_class_declaration: "abstract", interface_declaration: "interface", enum_declaration: "enum",
    class_definition: "class", struct_item: "record", enum_item: "enum", trait_item: "interface"
  };
  const tsMembers = new Set(["method_definition", "method_signature", "abstract_method_signature", "public_field_definition", "property_signature"]);
  const rustTypes = new Map<string, { id: string; kind: string }>();
  if (language === "rust") {
    const scanRust = (node: Node): void => {
      if (typeDeclarations[node.type] && /^(?:struct_item|enum_item|trait_item)$/.test(node.type)) {
        const name = node.childForFieldName("name");
        if (name) {
          const line = node.startPosition.row + 1;
          rustTypes.set(name.text, { id: symbolId(path, name.text, line), kind: typeDeclarations[node.type]! });
        }
      }
      for (const child of node.namedChildren) scanRust(child);
    };
    scanRust(tree.rootNode);
  }
  const visit = (node: Node, scope?: TypeScope, allowDeclarations = true): void => {
    const name = node.childForFieldName("name");
    if (language === "rust") {
      if (node.type === "use_declaration") {
        const arg = node.childForFieldName("argument");
        if (arg) addImport(node, (arg.type === "scoped_use_list" || arg.type === "use_as_clause" ? arg.childForFieldName("path")?.text ?? arg.text : arg.text).replace(/::\*$/, ""));
      }
      if (node.type === "mod_item" && !node.childForFieldName("body") && name) addImport(node, name.text, "module");
      if (typeDeclarations[node.type] && /^(?:struct_item|enum_item|trait_item)$/.test(node.type) && name) {
        const id = addSymbol(node, name, {
          ...(hasToken(node, "abstract") ? { abstract: true } : {}),
          ...(visibilityOf(node) ? { visibility: visibilityOf(node) } : {})
        });
        if (node.type === "struct_item") {
          const body = node.childForFieldName("body");
          for (const field of body?.namedChildren ?? []) {
            if (field.type !== "field_declaration") continue;
            const fieldName = field.childForFieldName("name");
            if (!fieldName) continue;
            const type = field.childForFieldName("type");
            addSymbol(field, fieldName, { ownerId: id, ownerName: name.text, memberKind: "field", ...(type ? { typeText: type.text } : {}), ...(visibilityOf(field) ? { visibility: visibilityOf(field) } : {}) });
          }
        }
        if (node.type === "enum_item") {
          const body = node.childForFieldName("body");
          for (const variant of body?.namedChildren ?? []) {
            if (variant.type !== "enum_variant") continue;
            const variantName = variant.childForFieldName("name");
            if (variantName) addSymbol(variant, variantName, { ownerId: id, ownerName: name.text, memberKind: "field" });
          }
        }
        if (node.type === "trait_item") for (const child of node.childForFieldName("body")?.namedChildren ?? []) visit(child, { id, name: name.text, kind: "interface" }, allowDeclarations);
        return;
      }
      if (node.type === "impl_item") {
        const ownerName = node.childForFieldName("type")?.text;
        if (ownerName) {
          const declared = rustTypes.get(typeName(ownerName));
          const owner = { id: declared?.id ?? "", name: typeName(ownerName), kind: declared?.kind ?? "record" };
          for (const child of node.childForFieldName("body")?.namedChildren ?? []) visit(child, owner, allowDeclarations);
        }
        return;
      }
      if ((node.type === "function_item" || node.type === "function_signature_item") && name) {
        const parameters = node.childForFieldName("parameters");
        const returns = node.childForFieldName("return_type");
        const member = scope && node.parent?.type === "declaration_list";
        addSymbol(node, name, {
          ...(member ? { ...(scope.id ? { ownerId: scope.id } : {}), ownerName: scope.name, memberKind: "method" as const } : {}),
          ...(parametersText(parameters?.text) ? { parameters: parametersText(parameters?.text) } : {}),
          ...(returns?.text ? { returns: returns.text } : {}),
          ...(visibilityOf(node) ? { visibility: visibilityOf(node) } : {}),
          ...(node.type === "function_signature_item" || hasToken(node, "abstract") ? { abstract: true } : {})
        });
        return;
      }
      for (const child of node.namedChildren) visit(child, scope, allowDeclarations);
      return;
    }
    if (language === "python") {
      if (node.type === "import_from_statement") {
        addImport(node, node.childForFieldName("module_name")?.text ?? "");
      } else if (node.type === "import_statement") {
        for (const child of node.namedChildren) addImport(node, child.type === "aliased_import" ? child.childForFieldName("name")?.text ?? "" : child.text);
      }
      if (node.type === "class_definition" && name) {
        const bases = (node.childForFieldName("superclasses")?.namedChildren ?? [])
          .map((base) => typeName(base.text)).filter((base) => base && base !== "object");
        const id = addSymbol(node, name, {
          ...(hasToken(node, "abstract") ? { abstract: true } : {}),
          ...(bases.length ? { extends: [...new Set(bases)] } : {})
        });
        for (const child of node.childForFieldName("body")?.namedChildren ?? []) visit(child, { id, name: name.text, kind: "class" }, allowDeclarations);
        return;
      }
      const inClassBody = scope && (node.parent?.type === "block"
        || (node.parent?.type === "decorated_definition" && node.parent.parent?.type === "block")
        || (node.parent?.type === "expression_statement" && node.parent.parent?.type === "block"));
      if (inClassBody && allowDeclarations) {
        if (node.type === "function_definition" && name) {
          const decorators = node.parent?.type === "decorated_definition"
            ? node.parent.namedChildren.filter((child) => child.type === "decorator").map((child) => child.text.replace(/^@/, "").trim()) : [];
          const parameters = node.childForFieldName("parameters");
          const returns = node.childForFieldName("return_type");
          addSymbol(node, name, {
            ownerId: scope.id, ownerName: scope.name, memberKind: "method",
            ...(parametersText(parameters?.text) ? { parameters: parametersText(parameters?.text) } : {}),
            ...(returns?.text ? { returns: returns.text } : {}),
            ...(decorators.includes("staticmethod") || decorators.includes("classmethod") ? { static: true } : {}),
            ...(decorators.includes("abstractmethod") ? { abstract: true } : {})
          });
          for (const child of node.namedChildren) visit(child, scope, false);
          return;
        }
        if (node.type === "assignment") {
          const left = node.childForFieldName("left");
          const annotation = node.childForFieldName("type");
          if (left && annotation && left.type === "identifier") {
            addSymbol(node, left, { ownerId: scope.id, ownerName: scope.name, memberKind: "field", typeText: annotation.text });
            return;
          }
        }
      }
      if (node.type === "function_definition" && name && (!scope || allowDeclarations)) {
        const parameters = node.childForFieldName("parameters");
        const returns = node.childForFieldName("return_type");
        addSymbol(node, name, {
          ...(parametersText(parameters?.text) ? { parameters: parametersText(parameters?.text) } : {}),
          ...(returns?.text ? { returns: returns.text } : {})
        });
        return;
      }
      for (const child of node.namedChildren) visit(child, scope, allowDeclarations);
      return;
    }
    // TypeScript / JavaScript.
    if (node.type === "import_statement" || node.type === "export_statement") {
      const source = node.childForFieldName("source");
      if (source) {
        const clause = node.namedChildren.find((child) => child.type === "import_clause" || child.type === "export_clause");
        const named = clause?.namedChildren.find((child) => child.type === "named_imports") ?? clause;
        const specifiers = named?.namedChildren.filter((child) => child.type === "import_specifier" || child.type === "export_specifier") ?? [];
        const typeOnly = node.children.some((child) => child.type === "type") || !!(specifiers.length
          && named?.namedChildren.length === specifiers.length
          && (!clause || clause === named || clause.namedChildren.length === 1)
          && specifiers.every((child) => child.children.some((token) => token.type === "type")));
        addImport(node, unquote(source.text), "import", typeOnly);
      }
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function")?.text;
      if (fn === "require" || fn === "import") {
        const arg = node.childForFieldName("arguments")?.namedChildren[0];
        addImport(node, arg?.type === "string" ? unquote(arg.text) : "<dynamic>", arg?.type === "string" ? "import" : "dynamic");
      }
    }
    if (typeDeclarations[node.type] && name && allowDeclarations) {
      const heritage = node.namedChildren.find((child) => child.type === "class_heritage");
      const extendsClause = heritage?.namedChildren.find((child) => child.type === "extends_clause");
      const implementations = heritage?.namedChildren.find((child) => child.type === "implements_clause");
      const extendNames = extendsClause ? [typeName(extendsClause.childForFieldName("value")?.text ?? extendsClause.namedChildren[0]?.text ?? "")].filter(Boolean) : [];
      const implementNames = (implementations?.namedChildren ?? []).map((child) => typeName(child.text)).filter(Boolean);
      const abstract = typeDeclarations[node.type] === "abstract" || hasToken(node, "abstract");
      const id = addSymbol(node, name, {
        ...(abstract ? { abstract: true } : {}),
        ...(visibilityOf(node) ? { visibility: visibilityOf(node) } : {}),
        ...(extendNames.length ? { extends: [...new Set(extendNames)] } : {}),
        ...(implementNames.length ? { implements: [...new Set(implementNames)] } : {})
      });
      for (const child of node.namedChildren) visit(child, { id, name: name.text, kind: typeDeclarations[node.type]! }, allowDeclarations);
      return;
    }
    const inClassBody = scope && (node.parent?.type === "class_body" || node.parent?.type === "interface_body");
    if (inClassBody && allowDeclarations && tsMembers.has(node.type) && name) {
      const method = node.type === "method_definition" || node.type === "method_signature" || node.type === "abstract_method_signature";
      const parameters = node.childForFieldName("parameters");
      const returns = node.childForFieldName("return_type");
      const annotation = node.childForFieldName("type");
      addSymbol(node, name, {
        ownerId: scope.id, ownerName: scope.name, memberKind: method ? "method" : "field",
        ...(method && parametersText(parameters?.text) ? { parameters: parametersText(parameters?.text) } : {}),
        ...(method && returns ? { returns: typeAnnotation(returns.text) ?? returns.text } : {}),
        ...(!method && annotation ? { typeText: typeAnnotation(annotation.text) ?? annotation.text } : {}),
        ...(visibilityOf(node) ? { visibility: visibilityOf(node) } : {}),
        ...(hasToken(node, "static") ? { static: true } : {}),
        ...(node.type === "abstract_method_signature" || hasToken(node, "abstract") ? { abstract: true } : {})
      });
      for (const child of node.namedChildren) visit(child, scope, false);
      return;
    }
    if (allowDeclarations && !scope && name && declarations.test(node.type)) {
      const body = node.childForFieldName("body") ?? node.childForFieldName("value")?.childForFieldName("body");
      if (node.type !== "variable_declarator" || ["arrow_function", "function_expression"].includes(node.childForFieldName("value")?.type ?? "")) {
        addSymbol(node, name, { ...(body ? {} : {}) });
        return;
      }
    }
    // Walk declarations/imports, but do not collect local variables as public module structure.
    for (const child of node.namedChildren) visit(child, scope, allowDeclarations);
  };
  try {
    visit(tree.rootNode);
    return { path, hash: digest(content), language, lines: content.split("\n").length, errors: tree.rootNode.hasError, symbols, imports };
  } finally { tree.delete(); }
}

type Config = { path: string; directory: string; value: Record<string, unknown> };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function configs(inputs: readonly StructureInput[]): Config[] {
  return inputs.filter(input => /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|jsconfig\.json|Cargo\.toml|pyproject\.toml)$/.test(input.path) && input.content !== undefined).flatMap(input => {
    try { return [{ path: input.path, directory: posix.dirname(input.path), value: record(input.path.endsWith(".toml") ? parseToml(input.content!) : parseJson(input.content!)) }]; }
    catch { return []; }
  });
}
const within = (path: string, directory: string): boolean => directory === "." || path.startsWith(`${directory}/`);
const nearest = (path: string, list: readonly Config[], pattern: RegExp): Config | undefined => list.filter(item => pattern.test(item.path) && within(path, item.directory)).sort((a, b) => b.directory.length - a.directory.length)[0];

function resolveDependencies(files: readonly StructureFile[], config: readonly Config[]): StructureDependency[] {
  const available = new Set(files.map(file => file.path));
  const find = (candidates: string[]): string | undefined => [...new Set(candidates.map(path => posix.normalize(path)))].find(path => available.has(path));
  const js = (base: string): string[] => [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].flatMap(ext => [base + ext, `${base}/index${ext}`]), ...(/\.[cm]?js$/.test(base) ? [base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base.replace(/\.mjs$/, ".mts"), base.replace(/\.cjs$/, ".cts")] : [])];
  const py = (base: string): string[] => [`${base}.py`, `${base}/__init__.py`];
  const rs = (base: string): string[] => [`${base}.rs`, `${base}/mod.rs`];
  return files.flatMap(file => file.imports.map(item => {
    const directory = posix.dirname(file.path), spec = item.specifier;
    const candidates: string[] = [];
    if (item.kind !== "dynamic") {
      if (file.language === "python") {
        const prefix = spec.match(/^\.+/)?.[0] ?? "";
        const tail = spec.slice(prefix.length).replaceAll(".", "/");
        if (prefix) candidates.push(...py(posix.join(directory, ...Array.from({ length: prefix.length - 1 }, () => ".."), tail)));
        else {
          const root = nearest(file.path, config, /pyproject\.toml$/)?.directory ?? ".";
          candidates.push(...py(posix.join(root, tail)), ...py(posix.join(root, "src", tail)));
        }
      } else if (file.language === "rust") {
        const root = nearest(file.path, config, /Cargo\.toml$/)?.directory ?? ".";
        const local = /(?:^|\/)(?:lib|main|mod)\.rs$/.test(file.path) ? directory : file.path.replace(/\.rs$/, "");
        if (item.kind === "module") candidates.push(...rs(posix.join(local, spec)));
        else if (spec === "crate") candidates.push(posix.join(root, "src/lib.rs"));
        else if (spec.startsWith("crate::")) candidates.push(...rs(posix.join(root, "src", spec.slice(7).replaceAll("::", "/"))));
        else if (spec.startsWith("self::")) candidates.push(...rs(posix.join(local, spec.slice(6).replaceAll("::", "/"))));
        else if (spec.startsWith("super::")) candidates.push(...rs(posix.join(local, spec.replace(/super::/g, "../").replaceAll("::", "/"))));
        else {
          const parts = spec.split("::"), name = parts.shift();
          const crate = config.find(c => { const packageName = record(c.value.package).name; return /Cargo\.toml$/.test(c.path) && typeof packageName === "string" && packageName.replaceAll("-", "_") === name; });
          if (crate) candidates.push(...(parts.length ? rs(posix.join(crate.directory, "src", ...parts)) : [posix.join(crate.directory, "src/lib.rs")]));
        }
      } else if (spec.startsWith(".")) candidates.push(...js(posix.join(directory, spec)));
      else {
        const ts = nearest(file.path, config, /(?:tsconfig[^/]*|jsconfig)\.json$/);
        const compiler = record(ts?.value.compilerOptions);
        const base = posix.join(ts?.directory ?? ".", typeof compiler.baseUrl === "string" ? compiler.baseUrl : ".");
        for (const [pattern, targets] of Object.entries(record(compiler.paths))) {
          const [before, after] = pattern.split("*");
          const match = pattern.includes("*") ? spec.startsWith(before!) && spec.endsWith(after ?? "") : pattern === spec;
          if (match && Array.isArray(targets)) for (const target of targets) if (typeof target === "string") candidates.push(...js(posix.join(base, target.replace("*", spec.slice(before!.length, after ? -after.length : undefined)))));
        }
        if (typeof compiler.baseUrl === "string") candidates.push(...js(posix.join(base, spec)));
        for (const pkg of config.filter(c => /package\.json$/.test(c.path) && typeof c.value.name === "string")) {
          const name = String(pkg.value.name);
          if (spec === name) {
            for (const key of ["source", "types", "module", "main"]) if (typeof pkg.value[key] === "string") candidates.push(...js(posix.join(pkg.directory, String(pkg.value[key]))));
          } else if (spec.startsWith(`${name}/`)) candidates.push(...js(posix.join(pkg.directory, spec.slice(name.length + 1))));
        }
      }
    }
    // A Rust use may name a symbol inside the module. Resolve only the containing source file.
    if (file.language === "rust" && item.kind === "import") for (const candidate of [...candidates]) {
      if (candidate.endsWith(".rs") && !candidate.endsWith("/mod.rs")) candidates.push(...rs(posix.dirname(candidate)));
    }
    const to = find(candidates);
    return { from: file.path, ...item, status: to ? "resolved" as const : "unresolved" as const, ...(to ? { to } : {}) };
  }));
}

/** A deterministic coverage-first map. Ranking chooses detail within each module, never modules. */
function summarize(files: readonly StructureFile[], config: readonly Config[], dependencies: readonly StructureDependency[]): StructureModule[] {
  const groups = new Map<string, { package: string; files: StructureFile[] }>();
  const owner = new Map<string, string>();
  for (const file of files) {
    const pkg = nearest(file.path, config, /(?:package\.json|Cargo\.toml|pyproject\.toml)$/)?.directory ?? ".";
    const parts = posix.relative(pkg, file.path).split("/");
    // Preserve a package's major areas; nested directories stay represented in the local index.
    const depth = ["src", "lib"].includes(parts[0] ?? "") ? 2 : 1;
    const path = posix.join(pkg, ...parts.slice(0, Math.min(parts.length - 1, depth)));
    const group = groups.get(path) ?? { package: pkg, files: [] };
    group.files.push(file); groups.set(path, group); owner.set(file.path, path);
  }
  const edgesByModule = new Map<string, StructureDependency[]>();
  const fileEdges = new Map<string, StructureMember["dependencies"]>();
  for (const edge of dependencies) {
    const imports = fileEdges.get(edge.from) ?? [];
    imports.push({ specifier: edge.specifier, ...(edge.to ? { to: edge.to } : {}), ...(edge.typeOnly ? { typeOnly: true } : {}) }); fileEdges.set(edge.from, imports);
    const module = owner.get(edge.from)!;
    const group = edgesByModule.get(module) ?? []; group.push(edge); edgesByModule.set(module, group);
  }
  // Repo-map-style graph ranking allocates detail inside each module. It cannot remove a module.
  const count = Math.max(1, files.length);
  const ranks = rankStructureFiles(files.map(file => file.path), dependencies);
  const id = (path: string): string => `module:${path}`;
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([path, group]) => {
    const ranked = [...group.files].sort((a, b) => {
      const score = (file: StructureFile) => (ranks.get(file.path) ?? 0) * count + (/(?:^|\/)(?:main|index|lib|mod|extension|app|__init__|__main__)\./.test(file.path) ? 10 : 0);
      return score(b) - score(a) || a.path.localeCompare(b.path);
    });
    const edges = edgesByModule.get(path) ?? [];
    const references = new Map<string, { specifier: string; status: "resolved" | "unresolved"; count: number }>();
    for (const edge of edges) {
      const key = `${edge.status}:${edge.specifier}`, reference = references.get(key) ?? { specifier: edge.specifier, status: edge.status, count: 0 };
      reference.count++; references.set(key, reference);
    }
    const targets = [...new Set(edges.flatMap(edge => edge.to && owner.get(edge.to) !== path ? [id(owner.get(edge.to)!)] : []))].sort();
    return { id: id(path), path, package: group.package, languages: [...new Set(group.files.map(file => file.language))].sort(), files: group.files.length,
      members: ranked.map(file => ({ path: file.path, hash: file.hash, language: file.language, lines: file.lines, symbols: file.symbols, dependencies: fileEdges.get(file.path) ?? [] })),
      entryPoints: ranked.slice(0, 3).map(file => file.path), symbols: ranked.flatMap(file => file.symbols.slice(0, 4).map(symbol => ({ path: file.path, ...symbol }))).slice(0, 12),
      evidence: ranked.slice(0, 3).map(file => ({ path: file.path, contentHash: file.hash })),
      references: [...references.values()].sort((a, b) => b.count - a.count || a.specifier.localeCompare(b.specifier)).slice(0, 12),
      dependsOn: targets, dependencyCount: edges.filter(edge => edge.status === "resolved").length, unresolved: edges.filter(edge => edge.status === "unresolved").length,
      hash: digest(JSON.stringify(group.files.map(file => [file.path, file.hash]))) };
  });
}

export async function buildStructureIndex(inputs: AsyncIterable<StructureInput> | Iterable<StructureInput>, options: {
  assetsPath?: string; cache?: StructureCache; signal?: AbortSignal;
  onProgress?: (count: number) => void;
} = {}): Promise<StructureIndex> {
  const previous = new Map(options.cache?.files.map(file => [file.path, file]) ?? []);
  const files: StructureFile[] = [], configuration: StructureInput[] = [], issues: StructureSummary["issues"] = [];
  const parsers = new Map<string, TreeSitter.Parser>();
  let cached = 0, count = 0, unsupported = 0;
  try {
    for await (const input of inputs) {
      options.signal?.throwIfAborted();
      count++;
      const language = structureLanguage(input.path);
      if (input.issue || input.content === undefined) { issues.push({ path: input.path, reason: input.issue ?? "Unreadable file" }); continue; }
      if (!language) {
        if (/\.(?:json|toml)$/.test(input.path)) configuration.push(input);
        else if (!/\.(?:md|mdx|rst|txt)$/.test(input.path)) unsupported++;
        continue;
      }
      const old = previous.get(input.path);
      if (old?.hash === digest(input.content) && old.language === language) { files.push(old); cached++; }
      else {
        let parser = parsers.get(language);
        // A missing/incompatible parser is an installation failure, not a silently skipped language.
        if (!parser) { parser = await parserFor(language, options.assetsPath); parsers.set(language, parser); }
        try { files.push(extract(parser, input.path, input.content, language)); }
        catch { issues.push({ path: input.path, reason: "Could not parse source" }); }
      }
      if (files.at(-1)?.errors) issues.push({ path: input.path, reason: "Syntax errors; structure is partial" });
      options.onProgress?.(count);
      if (count % 20 === 0) await new Promise<void>(done => setImmediate(done));
    }
  } finally { for (const parser of parsers.values()) parser.delete(); }
  options.signal?.throwIfAborted();
  files.sort((a, b) => a.path.localeCompare(b.path));
  const config = configs(configuration), dependencies = resolveDependencies(files, config);
  const modules = summarize(files, config, dependencies);
  const hash = digest(JSON.stringify({ version: PROJECT_STRUCTURE_VERSION, files: files.map(file => [file.path, file.hash]), config, issues }));
  const summary: StructureSummary = { version: 2, hash, files: count, parsed: files.length, cached, failed: issues.length, unsupported, modules, issues };
  const index = { cache: { version: PROJECT_STRUCTURE_VERSION, files }, dependencies, summary } as const;
  return { ...index, graph: buildStructureGraph(index) };
}
