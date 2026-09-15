import { posix } from "node:path";
import { parser } from "@lezer/python";
import type { ArchitectureModule, ArchitectureRelation } from "./projectArchitecture.js";
import type { SourceFileInput, LanguageScan } from "./projectArchitectureTypeScript.js";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function moduleIdFor(path: string): string {
  return normalizePath(path).replace(/\.py$/, "");
}

function moduleFor(path: string): ArchitectureModule {
  const normalized = normalizePath(path);
  const id = moduleIdFor(path);
  return { id, name: id.split("/").at(-1) ?? id, language: "python", paths: [normalized], source: "detected" };
}

export interface PythonImportReference {
  specifier: string;
  level: number;
  line: number;
}

const IMPORT_PATTERN = /^[ \t]*(?:from[ \t]+(?<relative>\.*)(?<fromModule>[A-Za-z_][\w.]*)?[ \t]+import\b|import[ \t]+(?<plain>[A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*))/gm;
const DYNAMIC_PATTERN = /\b(?:importlib\s*\.\s*import_module|__import__)\s*\(/;

/** Extracts static import references from Python source, including relative levels. */
export function extractPythonImports(content: string): PythonImportReference[] {
  const references: PythonImportReference[] = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const line = content.slice(0, match.index ?? 0).split(/\r?\n/).length;
    const groups = match.groups ?? {};
    if (groups.relative !== undefined) {
      const fromModule = groups.fromModule ?? "";
      references.push({ specifier: fromModule, level: groups.relative.length, line });
      continue;
    }
    const plain = groups.plain ?? "";
    for (const part of plain.split(",")) {
      const trimmed = part.trim();
      if (trimmed) references.push({ specifier: trimmed, level: 0, line });
    }
  }
  return references;
}

function resolvePythonModule(fromId: string, reference: PythonImportReference, known: ReadonlySet<string>): { to?: string; ambiguous?: string; unresolved?: string } {
  const base = fromId.slice(0, fromId.lastIndexOf("/") + 1);
  let root = base;
  if (reference.level > 0) {
    for (let index = 1; index < reference.level; index += 1) root = root.slice(0, Math.max(0, root.lastIndexOf("/", root.length - 2) + 1));
  }
  const dotted = reference.specifier.replaceAll(".", "/");
  const candidate = reference.level > 0 ? posix.normalize(`${root}${dotted}`) : posix.normalize(dotted);
  const exact = [candidate, `${candidate}/__init__`].filter((id) => known.has(id));
  if (exact.length === 1) return { to: exact[0]! };
  if (exact.length > 1) return { ambiguous: candidate };
  const suffix = [...known].filter((id) => id === candidate || id.endsWith(`/${candidate}`) || id === `${candidate}/__init__` || id.endsWith(`/${candidate}/__init__`));
  if (suffix.length === 1) return { to: suffix[0]! };
  if (suffix.length > 1) return { ambiguous: candidate };
  if (reference.level > 0) return { unresolved: `${".".repeat(reference.level)}${reference.specifier}` };
  return {};
}

/**
 * Scans Python sources for module relations.
 *
 * Relative imports resolve against the importing file's package directory. Namespace packages
 * without `__init__.py` still resolve by path, while dynamic imports and ambiguous names are kept
 * as explicit uncertainty instead of being reported as certain dependencies.
 */
export function scanPython(files: readonly SourceFileInput[]): LanguageScan {
  const modules = files.map((file) => moduleFor(file.path));
  const known = new Set(modules.map((module) => module.id));
  const relations: ArchitectureRelation[] = [];
  const unsupported: { path: string; reason: string }[] = [];
  for (const file of files) {
    const tree = parser.parse(file.content);
    if (tree.length === 0) unsupported.push({ path: file.path, reason: "Python source could not be parsed." });
    const from = moduleIdFor(file.path);
    for (const reference of extractPythonImports(file.content)) {
      const resolved = resolvePythonModule(from, reference, known);
      if (resolved.to) {
        relations.push({ from, to: resolved.to, source: "detected", confidence: 0.95, file: file.path, line: reference.line });
        continue;
      }
      if (resolved.ambiguous) {
        unsupported.push({ path: file.path, reason: `Ambiguous Python import '${reference.specifier}' matched more than one module.` });
        continue;
      }
      if (resolved.unresolved) unsupported.push({ path: file.path, reason: `Relative Python import '${resolved.unresolved}' could not be resolved to a scanned module.` });
    }
    if (DYNAMIC_PATTERN.test(file.content)) unsupported.push({ path: file.path, reason: "Dynamic Python import cannot be determined statically." });
  }
  return { modules, relations, unsupported, parserVersion: "@lezer/python" };
}
