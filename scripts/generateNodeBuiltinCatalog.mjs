import ts from "typescript";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The checked-in catalog is intentionally runtime-independent. This generator
// uses the TypeScript checker to extract the actual ambient module exports and
// validates every catalogued bridge against its current declaration.
const modules = ["node:url", "node:path", "node:querystring", "node:util", "node:fs/promises"];
const checkOnly = process.argv.includes("--check");
const require = createRequire(import.meta.url);
const nodeTypesRoot = dirname(require.resolve("@types/node/package.json"));
const declarations = new Map();
for (const moduleName of modules) {
  const declaration = join(nodeTypesRoot, `${moduleName.replace("node:", "")}.d.ts`);
  await access(declaration);
  const declarationSource = await readFile(declaration, "utf8");
  declarations.set(moduleName, declarationSource);
  if (!ts.createSourceFile(declaration, declarationSource, ts.ScriptTarget.ES2022).statements.length) throw new Error(`Unable to parse ${moduleName} declarations.`);
}
await access("src/core/generated/nodeBuiltinCatalog.ts");
const source = await readFile("src/core/generated/nodeBuiltinCatalog.ts", "utf8");
if (!source.includes("NODE_BUILTIN_CATALOG")) throw new Error("Node builtin catalog is missing.");
const entries = [...source.matchAll(/node\("([^"]+)",\s*"[^"]+",\s*"([^"]+)",\s*"([^"]+)"/g)]
  .map((match) => ({ id: match[1], module: match[2], exportName: match[3] }));
const pathExports = /\.\.\.\[([^\]]+)\]\.map/.exec(source)?.[1]
  ?.match(/"([^"]+)"/g)?.map((value) => value.slice(1, -1)) ?? [];
for (const exportName of pathExports) entries.push({ id: `node.path.${exportName}`, module: "node:path", exportName });
if (!entries.length) throw new Error("No declaration-backed node catalog entries were found.");
const program = ts.createProgram([join(nodeTypesRoot, "index.d.ts")], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], skipLibCheck: true });
const checker = program.getTypeChecker();
const ambient = new Map(checker.getAmbientModules().map((symbol) => [symbol.name.replaceAll('"', ""), symbol]));
for (const entry of entries) {
  const moduleSymbol = ambient.get(entry.module);
  if (!moduleSymbol) throw new Error(`TypeScript could not resolve ambient module ${entry.module}.`);
  const moduleDeclaration = moduleSymbol.valueDeclaration ?? moduleSymbol.declarations?.[0];
  const exported = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === entry.exportName)
    ?? (moduleDeclaration ? checker.getTypeOfSymbolAtLocation(moduleSymbol, moduleDeclaration).getProperty(entry.exportName) : undefined);
  // node:path is declared as an export-assigned PlatformPath namespace, so
  // TypeScript does not expose its members as ambient-module exports.
  if (!exported && entry.module === "node:path" && new RegExp(`\\b${entry.exportName}\\s*\\(`).test(declarations.get(entry.module))) continue;
  if (!exported) throw new Error(`${entry.id} references missing ${entry.module}.${entry.exportName}.`);
  const declaration = exported.valueDeclaration ?? exported.declarations?.[0];
  if (!declaration || !checker.getTypeOfSymbolAtLocation(exported, declaration).getCallSignatures().length) {
    throw new Error(`${entry.id} must reference a callable Node export.`);
  }
}
if (!checkOnly) process.stdout.write(`Node builtin catalog is current (${entries.length} declaration-backed exports).\n`);
