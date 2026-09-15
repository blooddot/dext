import ts from "typescript";
import { posix } from "node:path";
import type { ArchitectureModule, ArchitectureRelation, ProjectLanguage } from "./projectArchitecture.js";

export interface SourceFileInput { path: string; content: string; }
export interface LanguageScan { modules: ArchitectureModule[]; relations: ArchitectureRelation[]; unsupported: { path: string; reason: string }[]; parserVersion: string; }

function moduleFor(path: string): ArchitectureModule {
  const normalized = path.replaceAll("\\", "/");
  const id = normalized.replace(/\.[cm]?[jt]sx?$/, "");
  return { id, name: id.split("/").at(-1) ?? id, language: "typescript", paths: [normalized], source: "detected" };
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = from.slice(0, from.lastIndexOf("/") + 1);
  return posix.normalize(`${base}${specifier}`).replace(/\.(?:[cm]?js|jsx|tsx?)$/, "");
}

export function scanTypeScript(files: readonly SourceFileInput[]): LanguageScan {
  const modules = files.map((file) => moduleFor(file.path));
  const byId = new Map(modules.map((module) => [module.id, module]));
  const relations: ArchitectureRelation[] = [];
  const unsupported: { path: string; reason: string }[] = [];
  for (const file of files) {
    const from = moduleFor(file.path).id;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    source.forEachChild((node) => {
      const specifier = ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text : undefined;
      if (specifier) {
        const to = resolveImport(file.path, specifier);
        if (to && byId.has(to)) relations.push({ from, to, source: "detected", confidence: 1, file: file.path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const to = resolveImport(file.path, node.arguments[0].text);
        if (to && byId.has(to)) relations.push({ from, to, source: "detected", confidence: 0.9, file: file.path });
      }
    });
    if (file.content.includes("import(") && !file.content.match(/import\(\s*["'`]/)) unsupported.push({ path: file.path, reason: "Dynamic import target cannot be determined statically." });
  }
  return { modules, relations, unsupported, parserVersion: ts.version } satisfies LanguageScan;
}

export type { ArchitectureModule, ArchitectureRelation, ProjectLanguage };
