import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const normalize = value => value.replaceAll("\\", "/");
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

/** The first clean-up wave declared these entries temporary. This round moved
 * every remaining real dependency to `shared`/`platform`/feature ownership, so
 * the table must stay empty: a new entry means a module landed in the wrong
 * environment. */
export const migrationExceptions = [];

/** Pure layers may name an implementation type only through one of these exact
 * edges. Each entry is `import type` only and produces no runtime import. */
export const declaredTypeEdges = [
  {
    from: "src/features/resources/contracts/resourceDocuments.ts",
    to: "src/platform/editor-tabs/editorTabManager.ts"
  },
  {
    from: "src/features/resources/contracts/resourceDocuments.ts",
    to: "src/platform/editor-tabs/editorTabSerializer.ts"
  },
  {
    from: "src/features/resources/contracts/resourceDocuments.ts",
    to: "src/platform/editor-tabs/editorTabState.ts"
  },
  {
    from: "src/features/resources/presentation/resourceDocuments.ts",
    to: "src/platform/editor-tabs/editorTabState.ts"
  },
  {
    from: "src/features/project/presentation/projectPanel.ts",
    to: "src/platform/editor-tabs/editorTabState.ts"
  },
  {
    from: "src/features/project/contracts/evidence.ts",
    to: "src/features/project/host/indexing/projectStructure.ts"
  }
];

/** The known cross-feature host couplings that survived this round. They are
 * registered so a new one fails until `app` supplies a narrow port. */
export const crossFeatureHostCouplings = [
  {
    from: "src/features/workflow/host/runtime.ts",
    to: "src/features/agents/host/agentRouter.ts"
  },
  {
    from: "src/features/workflow/host/runtime.ts",
    to: "src/features/agents/host/agentRunner.ts"
  },
  {
    from: "src/features/workflow/host/runtime.ts",
    to: "src/features/agents/host/resultRepair.ts"
  },
  {
    from: "src/features/project/host/generation/projectAiGeneration.ts",
    to: "src/features/agents/host/cliAxAIService.ts"
  }
];

/** Every path this and the previous migration replaced. None of them may come
 * back: a restored file, a static or type-only import, a literal dynamic load,
 * a mock or an inlined build entry string would silently recreate the
 * compatibility layer the migrations removed. */
export const removedModulePaths = [
  // Root adapters, composition roots and shared helpers.
  "src/application.ts",
  "src/sidebarProvider.ts",
  "src/attachmentStore.ts",
  "src/dextStorage.ts",
  "src/markdownCopy.ts",
  "src/readyMessageQueue.ts",
  "src/vscodeAttachments.ts",
  "src/vscodeClipboardFiles.ts",
  "src/vscodeContextHost.ts",
  "src/vscodePatchHost.ts",
  "src/vscodeSelectionActions.ts",
  "src/vscodeTerminalHost.ts",
  "src/vscodeTheme.ts",
  "src/webviewProtocol.ts",
  "src/platform/duration.ts",
  "src/platform/jsonOutput.ts",
  // Browser modules that moved into their feature, the platform or workflow.
  "src/webview/agentInputView.ts",
  "src/webview/agentTodoView.ts",
  "src/webview/composerOverflow.ts",
  "src/webview/conversationTabDrag.ts",
  "src/webview/dextTypesStatus.ts",
  "src/webview/fileReferenceChip.ts",
  "src/webview/interactionDialog.ts",
  "src/webview/interactionForm.ts",
  "src/webview/interactionMarkdown.ts",
  "src/webview/markdownDiagrams.ts",
  "src/webview/scrollProbe.ts",
  "src/webview/selectField.ts",
  "src/webview/selectionGroupField.ts",
  // Single-file feature contracts (now directories).
  "src/features/agents/contracts.ts",
  "src/features/workspace/contracts.ts",
  // First clean-up wave forwarders.
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
  "src/webview/projectPanel.ts",
  // The dissolved `core` directory.
  "src/core/agentAssertions.ts",
  "src/core/agentRouter.ts",
  "src/core/agentRunner.ts",
  "src/core/agentTimeout.ts",
  "src/core/agentTodoTracking.ts",
  "src/core/agentToolActivity.ts",
  "src/core/apiReference.ts",
  "src/core/apiSource.ts",
  "src/core/axAdapter.ts",
  "src/core/builtinCli.ts",
  "src/core/builtins.ts",
  "src/core/builtinTypeDefinitions.ts",
  "src/core/cliAxAIService.ts",
  "src/core/cliCompletion.ts",
  "src/core/codexConversationConnection.ts",
  "src/core/codexConversationEvents.ts",
  "src/core/codexConversationRunner.ts",
  "src/core/codexError.ts",
  "src/core/contextResolver.ts",
  "src/core/deepseekHarnessPolicy.ts",
  "src/core/deepseekHarnessRunner.ts",
  "src/core/deepseekHarnessTransport.ts",
  "src/core/dextApiTypes.ts",
  "src/core/elicitationForm.ts",
  "src/core/executionErrors.ts",
  "src/core/fileReference.ts",
  "src/core/harnessBridge.ts",
  "src/core/harnessCommand.ts",
  "src/core/harnessPresetDefault.ts",
  "src/core/harnessPresets.ts",
  "src/core/harnessQuestions.ts",
  "src/core/harnessResultTool.ts",
  "src/core/ignoreRules.ts",
  "src/core/mcpManifest.ts",
  "src/core/mcpRegistry.ts",
  "src/core/mcpSecrets.ts",
  "src/core/methodSignature.ts",
  "src/core/patch.ts",
  "src/core/registry.ts",
  "src/core/resultBoundary.ts",
  "src/core/resultRepair.ts",
  "src/core/resultSerialization.ts",
  "src/core/runtime.ts",
  "src/core/schemas.ts",
  "src/core/skillCatalog.ts",
  "src/core/syntaxParser.ts",
  "src/core/templateRender.ts",
  "src/core/types.ts",
  "src/core/uiForm.ts",
  "src/core/workflowRecorder.ts"
];

const forbiddenRootDirectories = ["src/core/", "src/modules/", "src/utils/", "src/common/", "src/base/"];

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
  // strings, so the extension and any relative prefix are optional. A trailing
  // slash is a directory, not the removed file.
  return new RegExp(`(?:^|[^\\w/])(?:\\.{1,2}/)*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.(?:ts|mts|cts|js|mjs|cjs))?(?![\\w/-])`);
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

const has = (value, prefix) => value.startsWith(prefix);
const featureName = file => /^src\/features\/([^/]+)\//.exec(file)?.[1];
const featureLayer = file => /^src\/features\/[^/]+\/([^/]+)\//.exec(file)?.[1];
const isFeature = file => file.startsWith("src/features/");
const isPureLayer = file => isFeature(file) && ["contracts", "domain", "knowledge", "presentation"].includes(featureLayer(file));
const isHostLayer = file => isFeature(file) && featureLayer(file) === "host";
const isBrowserLayer = file => isFeature(file) && featureLayer(file) === "browser";
const isContracts = file => /^src\/features\/[^/]+\/contracts\//.test(file);
const isShared = file => file.startsWith("src/shared/");

function declaredTypeEdge(from, to) {
  return declaredTypeEdges.some(edge => edge.from === from && edge.to === to);
}
function crossFeatureHostCoupling(from, to) {
  return crossFeatureHostCouplings.some(edge => edge.from === from && edge.to === to);
}
const isNodeBuiltin = specifier => nodeBuiltins.has(specifier);
const isPackage = specifier => !specifier.startsWith(".") && !specifier.startsWith("src/") && !isNodeBuiltin(specifier) && specifier !== "vscode";
const isDomGlobal = name => name === "window" || name === "document" || name === "navigator";

function checkDom(file, source, violations) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
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
    if (ts.isIdentifier(node) && isDomGlobal(node.text) && !locals.has(node.text) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) && !ts.isPropertyAssignment(node.parent) && !ts.isParameter(node.parent)) {
      // HTML template contents are string literals, not DOM expressions.
      if (node.parent && !ts.isVariableDeclaration(node.parent) && !ts.isTypeReferenceNode(node.parent)) violations.add(`${file}: DOM global ${node.text} in a non-browser module`);
    }
    ts.forEachChild(node, dom);
  }
  dom(tree);
}

export function checkModuleBoundaries(sources) {
  const files = new Map(Object.entries(sources).map(([file, source]) => [normalize(file), source]));
  const graph = new Map();
  const violations = new Set();
  for (const [file, source] of files) {
    const edges = importsOf(file, source).map(edge => {
      if (!edge.specifier.startsWith(".")) return { ...edge, to: edge.specifier };
      const raw = path.posix.normalize(path.posix.join(path.posix.dirname(file), edge.specifier));
      const to = [raw.replace(/\.js$/, ".ts"), `${raw}.ts`, `${raw}/index.ts`, raw].find(candidate => files.has(candidate)) ?? raw;
      return { ...edge, to };
    });
    graph.set(file, edges.filter(edge => !edge.typeOnly));
    if (!file.startsWith("src/")) continue;
    const add = message => violations.add(`${file}: ${message}`);

    // Root layout: one entry point, no resurrected top-level modules.
    if (/^src\/[^/]+\.ts$/.test(file) && file !== "src/extension.ts") add("the src root may only contain extension.ts");
    for (const dir of forbiddenRootDirectories) if (has(file, dir)) add(`src/${dir.slice(4, -1)} is dissolved and must not be restored`);
    if (/\/contracts\.ts$/.test(file)) add("feature contracts live in a contracts/ directory, never contracts.ts");
    if (/\/contracts\/index\.ts$/.test(file)) add("contracts must be imported by file, not through an index barrel");

    // Shared kernel: only contracts/protocol/lib, no environment at all.
    if (isShared(file)) {
      if (!/^src\/shared\/(contracts|protocol|lib)\//.test(file)) add("shared may only contain contracts/, protocol/ and lib/");
      for (const edge of edges) {
        if (edge.to.startsWith("src/") && !edge.to.startsWith("src/shared/")) add(`shared depends on ${edge.to}`);
        if (isNodeBuiltin(edge.to) || edge.to === "vscode") add(`shared depends on ${edge.to}`);
      }
    }

    // Platform: environment adapters, never feature implementations or the app.
    if (file.startsWith("src/platform/vscode/")) {
      for (const edge of edges) {
        if (edge.to.startsWith("src/app/") || edge.to.startsWith("src/webview/") || edge.to.startsWith("src/runner/")) add(`platform/vscode depends on ${edge.to}`);
        if (isFeature(edge.to) && ["host", "browser"].includes(featureLayer(edge.to))) add(`platform/vscode depends on feature implementation ${edge.to}`);
      }
    }
    if (file.startsWith("src/platform/node/")) {
      for (const edge of edges) {
        if (edge.to === "vscode" || edge.to.startsWith("src/app/") || edge.to.startsWith("src/webview/") || isFeature(edge.to)) add(`platform/node depends on ${edge.to}`);
      }
    }
    if (file.startsWith("src/platform/browser/")) {
      for (const edge of edges) {
        if (edge.to === "vscode" || isNodeBuiltin(edge.to) || edge.to.startsWith("src/app/") || edge.to.startsWith("src/webview/") || edge.to.startsWith("src/runner/")) add(`platform/browser depends on ${edge.to}`);
        if (isFeature(edge.to) && ["host", "browser"].includes(featureLayer(edge.to))) add(`platform/browser depends on feature implementation ${edge.to}`);
      }
    }
    if (file.startsWith("src/platform/editor-tabs/")) {
      for (const edge of edges) {
        if (edge.to.startsWith("src/app/") || edge.to.startsWith("src/webview/") || isFeature(edge.to)) add(`platform/editor-tabs depends on ${edge.to}`);
      }
    }
    if (file === "src/platform/webviewProtocol.ts") {
      for (const edge of edges) {
        if (edge.to.startsWith("src/app/") || edge.to.startsWith("src/webview/") || edge.to.startsWith("src/runner/")) add(`webviewProtocol depends on ${edge.to}`);
        if (isFeature(edge.to) && !isContracts(edge.to)) add(`webviewProtocol depends on feature implementation ${edge.to}`);
        if (edge.to.startsWith("src/platform/") && !edge.to.startsWith("src/platform/vscode/")) add(`webviewProtocol depends on platform adapter ${edge.to}`);
      }
    }

    // Features: environment direction per layer.
    if (isFeature(file)) {
      if (isPureLayer(file)) {
        for (const edge of edges) {
          if (!edge.to.startsWith("src/")) {
            if (edge.to === "vscode" || isNodeBuiltin(edge.to)) add(`pure layer depends on ${edge.to}`);
            continue;
          }
          if (edge.to.startsWith("src/app/") || edge.to.startsWith("src/webview/") || edge.to.startsWith("src/runner/")) add(`pure layer depends on ${edge.to}`);
          if (isFeature(edge.to) && ["host", "browser"].includes(featureLayer(edge.to))) {
            if (!edge.typeOnly) add(`pure layer runtime-depends on ${edge.to}`);
            else if (!declaredTypeEdge(file, edge.to)) add(`unregistered type edge to ${edge.to}`);
            continue;
          }
          if (edge.to.startsWith("src/platform/")) {
            if (!declaredTypeEdge(file, edge.to)) add(`pure layer depends on platform ${edge.to}`);
            continue;
          }
          if (isFeature(edge.to)) continue;
          if (edge.to.startsWith("src/shared/")) continue;
          add(`pure layer depends on ${edge.to}`);
        }
        checkDom(file, source, violations);
      } else if (isHostLayer(file)) {
        for (const edge of edges) {
          if (edge.to.startsWith("src/app/") || edge.to.startsWith("src/webview/")) add(`host depends on ${edge.to}`);
          if (isFeature(edge.to)) {
            if (featureName(edge.to) !== featureName(file) && featureLayer(edge.to) === "browser") add(`host depends on feature browser ${edge.to}`);
            if (featureName(edge.to) !== featureName(file) && featureLayer(edge.to) === "host" && !crossFeatureHostCoupling(file, edge.to)) add(`unregistered cross-feature host coupling ${edge.to}`);
          }
        }
        checkDom(file, source, violations);
      } else if (isBrowserLayer(file)) {
        for (const edge of edges) {
          if (edge.to === "vscode" || isNodeBuiltin(edge.to)) add(`browser depends on ${edge.to}`);
          if (edge.to.startsWith("src/app/") || edge.to.startsWith("src/webview/") || edge.to.startsWith("src/runner/")) add(`browser depends on ${edge.to}`);
          if (edge.to.startsWith("src/platform/") && !edge.to.startsWith("src/platform/browser/")) add(`browser depends on ${edge.to}`);
          if (isFeature(edge.to) && featureLayer(edge.to) === "host") add(`browser depends on host ${edge.to}`);
        }
      }
    }

    // The browser entry wires features; it never loads a host or the extension.
    if (file.startsWith("src/webview/")) {
      for (const edge of edges) {
        if (edge.to === "vscode" || isNodeBuiltin(edge.to)) add(`webview depends on ${edge.to}`);
        if (edge.to.startsWith("src/app/") || edge.to.startsWith("src/runner/")) add(`webview depends on ${edge.to}`);
        if (isFeature(edge.to) && !["browser", "contracts", "domain", "knowledge", "presentation"].includes(featureLayer(edge.to))) add(`webview depends on ${edge.to}`);
        if (edge.to.startsWith("src/platform/") && !edge.to.startsWith("src/platform/browser/") && edge.to !== "src/platform/webviewProtocol.ts") add(`webview depends on ${edge.to}`);
      }
    }

    if (file.startsWith("src/app/")) {
      for (const edge of edges) {
        if (edge.to.startsWith("src/webview/")) add(`app depends on browser entry ${edge.to}`);
      }
    }

    if (file.startsWith("src/runner/")) {
      for (const edge of edges) {
        if (edge.to.startsWith("src/") && !edge.to.startsWith("src/shared/") && !edge.to.startsWith("src/runner/")) add(`runner depends on ${edge.to}`);
        if (edge.to === "vscode") add("runner depends on vscode");
        if (isPackage(edge.to)) continue;
      }
    }
  }

  // Environment and cycle checks over the runtime graph.
  for (const [origin, source] of files) {
    if (!origin.startsWith("src/")) continue;
    const seen = new Set();
    function visit(file, chain) {
      if (chain.includes(file)) { violations.add(`Runtime cycle: ${[...chain.slice(chain.indexOf(file)), file].join(" -> ")}`); return; }
      if (seen.has(file)) return;
      seen.add(file);
      for (const edge of graph.get(file) ?? []) {
        if (files.has(edge.to)) visit(edge.to, [...chain, file]);
      }
    }
    visit(origin, []);
    void source;
  }

  for (const message of checkRemovedModuleReferences(Object.fromEntries(files))) violations.add(message);
  return [...violations].sort();
}

const browserForbidden = [
  /^src\/app\//,
  /^src\/platform\/vscode\//,
  /^src\/platform\/node\//,
  /^src\/features\/[^/]+\/host\//,
  /^src\/runner\//
];

export function checkBrowserMetafile(meta) {
  const errors = [];
  for (const file of Object.keys(meta.inputs ?? {})) for (const pattern of browserForbidden) if (pattern.test(normalize(file))) errors.push(`Browser bundle contains host implementation: ${file}`);
  for (const output of Object.values(meta.outputs ?? {})) for (const entry of output.imports ?? []) if (isNodeBuiltin(entry.path) || entry.path === "vscode") errors.push(`Browser bundle imports ${entry.path}`);
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
  for (const dir of ["src/core", "src/modules", "src/utils", "src/common", "src/base"]) {
    if (fs.existsSync(dir)) errors.push(`${dir}: dissolved directory must not be restored`);
  }
  const unique = [...new Set(errors)].sort();
  if (unique.length) { console.error(unique.join("\n")); process.exitCode = 1; }
  else console.log("Module boundaries passed.");
}
