import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const normalize = value => value.replaceAll("\\", "/");
const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), "vscode"]);

export const migrationExceptions = [
  { from: "src/features/project/browser/projectReader.ts", to: "src/webview/markdownDiagrams.ts", reason: "Existing shared browser diagram renderer", removeWhen: "Shared webview rendering moves to platform" },
  { from: "src/features/project/host/generation/projectAiGeneration.ts", to: "src/core/cliAxAIService.ts", reason: "Shared structured-output transport", removeWhen: "Agent transport contracts migrate" },
  { from: "src/features/project/host/indexing/projectStructure.ts", to: "src/core/syntaxParser.ts", reason: "Shared WASM parser loader", removeWhen: "Shared parser infrastructure migrates" },
  { from: "src/features/resources/host/resourceEditorProvider.ts", to: "src/core/methodSignature.ts", reason: "Workflow API signature presentation", removeWhen: "Workflow API contracts migrate" },
  // Conversation migration: real shared implementations that stayed outside this
  // round. Each entry is one dependency, not a forwarding entry.
  { from: "src/features/conversations/domain/planTodoProgress.ts", to: "src/core/agentTodoTracking.ts", reason: "Shared todo event reducer used by the runtime and the conversation", removeWhen: "Agent event contracts migrate" },
  { from: "src/features/conversations/host/historyEditorProvider.ts", to: "src/vscodeContextHost.ts", reason: "Shared file reference opener", removeWhen: "Workspace file opening moves to platform" },
  { from: "src/features/conversations/host/historyStore.ts", to: "src/core/fileReference.ts", reason: "Shared input reference normalizer", removeWhen: "Input references move to workspace contracts" },
  { from: "src/features/conversations/host/uiInteractionBroker.ts", to: "src/core/executionErrors.ts", reason: "Shared execution cancellation error", removeWhen: "Execution errors move to conversation contracts" },
  { from: "src/features/conversations/host/uiInteractionBroker.ts", to: "src/core/uiForm.ts", reason: "Shared form definition and validation", removeWhen: "UI form contracts migrate" },
  { from: "src/features/conversations/presentation/historyRender.ts", to: "src/core/fileReference.ts", reason: "Shared input reference display", removeWhen: "Input references move to workspace contracts" },
  { from: "src/features/conversations/presentation/historyRender.ts", to: "src/markdownCopy.ts", reason: "Shared Markdown copy helper", removeWhen: "Markdown tools move to platform" },
  { from: "src/features/conversations/contracts/protocol.ts", to: "src/core/uiForm.ts", reason: "Shared form schema and answer bounds for interaction messages", removeWhen: "UI form contracts move into conversation contracts" },
  { from: "src/features/conversations/host/conversationController.ts", to: "src/core/harnessPresetDefault.ts", reason: "Shared Harness preset default", removeWhen: "Agent preset contracts migrate" },
  { from: "src/features/conversations/host/turnExecutionCoordinator.ts", to: "src/core/harnessPresetDefault.ts", reason: "Shared Harness preset default", removeWhen: "Agent preset contracts migrate" },
  { from: "src/features/conversations/browser/transcriptView.ts", to: "src/core/fileReference.ts", reason: "Shared input reference display", removeWhen: "Input references move to workspace contracts" },
  { from: "src/features/conversations/browser/transcriptView.ts", to: "src/webview/fileReferenceChip.ts", reason: "Shared @reference chip element", removeWhen: "Input reference chips move to platform" },
  { from: "src/features/conversations/browser/transcriptView.ts", to: "src/webview/sourceHighlight.ts", reason: "Shared composer grammar highlighter", removeWhen: "Source highlighting moves to platform" }
];

/** Forwarding entries deleted by the first cleanup wave. None of them may come
 * back: a restored file, a static or type-only import, a literal dynamic load,
 * a mock or an inlined build entry string would silently recreate the
 * compatibility layer the migration removed. */
export const removedModulePaths = [
  "src/agentProfiles.ts",
  "src/apiEditorProvider.ts",
  "src/core/archifyAdapter.ts",
  "src/core/projectAiGeneration.ts",
  "src/core/projectArchitecture.ts",
  "src/core/projectContext.ts",
  "src/core/projectDiagram.ts",
  "src/core/projectDiagramAdapter.ts",
  "src/core/projectDiagramHistory.ts",
  "src/core/projectDiagramPresentation.ts",
  "src/core/projectDiagramRegistry.ts",
  "src/core/projectEvidenceSettings.ts",
  "src/core/projectIntent.ts",
  "src/core/projectKnowledge.ts",
  "src/core/projectMermaid.ts",
  "src/core/projectReference.ts",
  "src/core/projectSettings.ts",
  "src/core/projectTopics.ts",
  "src/core/toml.ts",
  "src/editorTabHtml.ts",
  "src/editorTabManager.ts",
  "src/editorTabSerializer.ts",
  "src/editorTabState.ts",
  "src/editorTabTypes.ts",
  "src/projectDiagramViewer.ts",
  "src/projectService.ts",
  "src/projectStore.ts",
  "src/resourceDocuments.ts",
  "src/resourceSession.ts",
  "src/vscodeProjectHost.ts",
  "src/webview/apiPanel.ts",
  "src/webview/archifyBridge.ts",
  "src/webview/fileSearchClient.ts",
  "src/webview/globalResourcesPanel.ts",
  "src/webview/outputLink.ts",
  "src/webview/projectPanel.ts"
];

/** A removed entry is compared without its extension, so `x.js`, `x.ts` and an
 * extensionless `x` are the same forwarder. */
function moduleKey(value) {
  return normalize(value).replace(/^\.\//, "").replace(/\.(?:ts|mts|cts|js|mjs|cjs)$/, "");
}

function specifierKeys(file, specifier) {
  if (!specifier.startsWith(".")) return [moduleKey(specifier)];
  const raw = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return [moduleKey(raw), moduleKey(raw.replace(/\.js$/, ".ts")), moduleKey(`${raw}.ts`), moduleKey(`${raw}/index.ts`)];
}

function removedPathPattern(key) {
  // Paths appear as `../src/x.js`, `./src/x.ts` or a bare `src/x` in script
  // strings, so the extension and any relative prefix are optional.
  return new RegExp(`(?:^|[^\\w/])(?:\\.{1,2}/)*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.(?:ts|mts|cts|js|mjs|cjs))?(?![\\w-])`);
}

/** Every reference to a removed path fails, including type-only imports, which
 * the runtime graph deliberately ignores. */
export function checkRemovedModuleReferences(sources, removed = removedModulePaths) {
  const keys = new Map(removed.map(value => [moduleKey(value), normalize(value)]));
  const found = new Map();
  const report = (file, key, message) => {
    const bucket = found.get(normalize(file)) ?? new Set();
    const token = `${key}\u0000${message}`;
    if ([...bucket].some(entry => entry.startsWith(`${key}\u0000`))) return;
    bucket.add(token);
    found.set(normalize(file), bucket);
  };
  for (const [file, source] of Object.entries(sources)) {
    if (keys.has(moduleKey(file))) report(file, moduleKey(file), `${normalize(file)}: removed migration module was restored`);
    for (const edge of importsOf(file, source)) {
      for (const key of specifierKeys(file, edge.specifier)) {
        if (keys.has(key)) report(file, key, `${normalize(file)} -> ${edge.specifier}: references a removed migration path`);
      }
    }
    // The guard and its own test must name the removed paths to prove the
    // guard works; those fixtures are data, not references that restore a
    // forwarder. Every other source, test and script is scanned.
    if (moduleKey(file) === "scripts/checkModuleBoundaries" || moduleKey(file) === "test/moduleBoundaries.test") continue;
    for (const [key, removedFile] of keys) {
      if (removedPathPattern(key).test(source)) report(file, key, `${normalize(file)}: references a removed migration path ${removedFile}`);
    }
  }
  return [...found.values()].flatMap(bucket => [...bucket].map(entry => entry.slice(entry.indexOf("\u0000") + 1))).sort();
}

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
  for (const message of checkRemovedModuleReferences(Object.fromEntries(files))) violations.add(message);
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
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? read(`${dir}/${entry.name}`) : /\.(?:ts|mjs)$/.test(entry.name) ? [[`${dir}/${entry.name}`, fs.readFileSync(`${dir}/${entry.name}`, "utf8")]] : []);
  }
  // Scripts and tests are scanned for removed paths too: an inlined esbuild
  // entry string or a mock specifier is a real reference even though it never
  // reaches the TypeScript program.
  const errors = checkModuleBoundaries(Object.fromEntries([...read("src"), ...read("test"), ...read("scripts")]));
  for (const removed of removedModulePaths) {
    if (fs.existsSync(removed)) errors.push(`${removed}: removed migration module was restored`);
  }
  const unique = [...new Set(errors)].sort();
  if (unique.length) { console.error(unique.join("\n")); process.exitCode = 1; }
  else console.log("Module boundaries passed.");
}
