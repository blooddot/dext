import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const normalize = value => value.replaceAll("\\", "/");
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), "vscode"]);

export const migrationExceptions = [
  { from: "src/features/project/browser/projectReader.ts", to: "src/webview/markdownDiagrams.ts", reason: "Existing shared browser diagram renderer", removeWhen: "Shared webview rendering moves to platform" },
  { from: "src/features/project/contracts/projectSettings.ts", to: "src/core/planFile.ts", reason: "Existing pure plan-path contract", removeWhen: "Conversation plan contracts migrate" },
  { from: "src/features/project/host/generation/projectAiGeneration.ts", to: "src/core/cliAxAIService.ts", reason: "Shared structured-output transport", removeWhen: "Agent transport contracts migrate" },
  { from: "src/features/project/host/indexing/projectStructure.ts", to: "src/core/syntaxParser.ts", reason: "Shared WASM parser loader", removeWhen: "Shared parser infrastructure migrates" },
  { from: "src/features/resources/host/resourceEditorProvider.ts", to: "src/core/methodSignature.ts", reason: "Workflow API signature presentation", removeWhen: "Workflow API contracts migrate" }
];

/** Type-only edges are recorded separately: they cannot load a host implementation. */
export function importsOf(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edges = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node;
      const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
      const typeOnly = !!clause?.isTypeOnly || !!(bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) && bindings.elements.length && bindings.elements.every(item => item.isTypeOnly) && !clause?.name);
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      edges.push({ specifier: node.argument.literal.text, typeOnly: true });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      edges.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return edges;
}

export function checkModuleBoundaries(sources, exceptions = migrationExceptions) {
  const files = new Map(Object.entries(sources).map(([file, source]) => [normalize(file), source]));
  const graph = new Map();
  const violations = new Set();
  const migrated = file => /^src\/(?:features|platform|app)\//.test(file);
  const pure = file => /^src\/features\/[^/]+\/(?:contracts(?:\/|\.ts$)|domain\/|knowledge\/|presentation\/)/.test(file);
  const browser = file => /^src\/features\/[^/]+\/browser\//.test(file);
  const exception = (from, to) => exceptions.some(item => item.from === from && item.to === to && item.reason && item.removeWhen);
  for (const [file, source] of files) {
    const edges = importsOf(file, source).map(edge => {
      if (!edge.specifier.startsWith(".")) return { ...edge, to: edge.specifier };
      const raw = path.posix.normalize(path.posix.join(path.posix.dirname(file), edge.specifier));
      const to = [raw.replace(/\.js$/, ".ts"), `${raw}.ts`, `${raw}/index.ts`, raw].find(candidate => files.has(candidate)) ?? raw;
      return { ...edge, to };
    });
    graph.set(file, edges.filter(edge => !edge.typeOnly));
    if (file.startsWith("src/features/")) for (const edge of edges) {
      if ((edge.to.startsWith("src/app/") || edge.to === "src/application.ts") && !exception(file, edge.to)) violations.add(`${file} -> ${edge.to}: feature depends on application composition`);
      if (!edge.typeOnly && edge.to.startsWith("src/") && !migrated(edge.to) && !exception(file, edge.to)) violations.add(`${file} -> ${edge.to}: undeclared legacy dependency`);
    }
  }
  for (const [origin] of files) {
    if (!migrated(origin)) continue;
    const seen = new Set();
    function visit(file, chain) {
      if (chain.includes(file)) { violations.add(`Runtime cycle: ${[...chain.slice(chain.indexOf(file)), file].join(" -> ")}`); return; }
      if (seen.has(file)) return;
      seen.add(file);
      for (const edge of graph.get(file) ?? []) {
        if ((browser(origin) || pure(origin)) && (builtins.has(edge.to) || /\/host\//.test(edge.to))) violations.add(`${origin} -> ${edge.to}: environment dependency through ${file}`);
        if (files.has(edge.to)) visit(edge.to, [...chain, file]);
      }
    }
    visit(origin, []);
    if (pure(origin)) {
      const tree = ts.createSourceFile(origin, files.get(origin), ts.ScriptTarget.Latest, true);
      const locals = new Set();
      const serialized = new Set();
      const called = new Set();
      function declarations(node) {
        if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) locals.add(node.name.text);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) called.add(node.expression.text);
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "toString" && ts.isIdentifier(node.expression.expression)) serialized.add(node.expression.expression.text);
        ts.forEachChild(node, declarations);
      }
      declarations(tree);
      function dom(node) {
        // Existing HTML generators serialize a binding function, never run it in the host.
        if (ts.isFunctionDeclaration(node) && node.name && serialized.has(node.name.text) && !called.has(node.name.text)) return;
        if (ts.isIdentifier(node) && ["window", "document", "navigator"].includes(node.text) && !locals.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !ts.isPropertyAssignment(node.parent) && !ts.isParameter(node.parent)) {
          // HTML template contents are string literals, not DOM expressions.
          if (node.parent && !ts.isVariableDeclaration(node.parent) && !ts.isTypeReferenceNode(node.parent)) violations.add(`${origin}: DOM global ${node.text} in pure module`);
        }
        ts.forEachChild(node, dom);
      }
      // DOM access is checked by the TypeScript AST, never a text search through HTML.
      dom(tree);
    }
  }
  return [...violations].sort();
}

export function checkBrowserMetafile(meta) {
  const errors = [];
  for (const file of Object.keys(meta.inputs ?? {})) if (/\/host\/|(?:^|\/)application\.ts$/.test(normalize(file))) errors.push(`Browser bundle contains host implementation: ${file}`);
  for (const output of Object.values(meta.outputs ?? {})) for (const entry of output.imports ?? []) if (builtins.has(entry.path)) errors.push(`Browser bundle imports ${entry.path}`);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  function read(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? read(`${dir}/${entry.name}`) : /\.(?:ts|mjs)$/.test(entry.name) ? [[`${dir}/${entry.name}`, fs.readFileSync(`${dir}/${entry.name}`, "utf8")]] : []);
  }
  const errors = checkModuleBoundaries(Object.fromEntries(read("src")));
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Module boundaries passed.");
}
