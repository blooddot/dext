/**
 * TypeScript language support for the composer editor.
 *
 * The composer used to speak Dext's own language. Dext now runs plain
 * TypeScript in the kernel, so the model is a `typescript` model and Monaco's
 * TypeScript worker owns completion, hover, signature help and diagnostics.
 *
 * `./monacoEnvironment.js` imports Monaco's TypeScript contribution for its
 * side effect, so its `languages.onLanguage("typescript", ...)` listener is
 * registered before the first composer model exists. That ordering matters:
 * `createModel` fires `requestRichLanguageFeatures` synchronously, and a
 * listener registered afterwards would never run. This module only reads the
 * contribution's defaults lazily, to configure the compiler and to inject the
 * `dext` declaration, neither of which has to happen at construction time.
 *
 * The `dext` module is declared by the generator in `src/core/dextApiTypes.ts`.
 * The extension host sends that declaration to every webview as
 * `{ type: "dextTypes", declaration }`; this module adds it as an extra lib so
 * `import { ask } from "dext"` resolves inside the composer.
 *
 * The Monaco TypeScript worker is bundled as `ts.worker.js` next to the editor
 * worker and is loaded through a blob URL: the webview CSP has no other way to
 * start a worker, which is also why the editor worker is blobbed.
 */
import type * as typescriptRegister from "monaco-editor/languages/features/typescript/register.js";
import { monaco } from "./monacoEnvironment.js";
import { dextBuiltinNames, dextTypesNotice } from "./dextTypesStatus.js";
import {
  dextApiSymbols, dextImportEdit, dextImportTargetAt, dextSymbolsFor,
  type DextSymbol, type DextSymbolKind
} from "./dextApiSymbols.js";

/** Monaco's icon for each kind of export the sources declare. Read at completion time:
 * the editor API only exists in a Webview, and the unit tests that load the editor stub it. */
function symbolKind(kind: DextSymbolKind): monaco.languages.CompletionItemKind {
  const kinds = monaco.languages.CompletionItemKind;
  switch (kind) {
    case "function": return kinds.Function;
    case "constant": return kinds.Constant;
    case "class": return kinds.Class;
    case "enum": return kinds.Enum;
    default: return kinds.Interface;
  }
}

type LanguageServiceDefaults = typescriptRegister.LanguageServiceDefaults;
type TypescriptContribution = typeof typescriptRegister;

/** Virtual path the `dext` declaration is registered under. The declaration is
 * an ambient `declare module "dext"`, so the path only names the virtual file. */
export const DEXT_DECLARATION_PATH = "file:///dext.d.ts";
/** Virtual root the workspace's API modules are registered under. It stands in for
 * `.dext`, and `apiPaths` — the generated project's own `dext/api/*` mapping — is
 * resolved against it, so a specifier resolves here exactly as it does in VS Code. */
export const DEXT_WORKSPACE_PATH = "file:///dext";
/** URI scheme of the composer's model. The completion is registered against *this*
 * rather than the language id: the composer switches between `typescript` (Code) and
 * `plaintext` (Chat), and a mode that has not switched yet must not decide whether the
 * editor can complete anything at all. */
export const DEXT_COMPOSER_SCHEME = "dext-input";
/** Worker asset bundled next to `editor.worker.js`. */
export const DEXT_TYPESCRIPT_WORKER = "ts.worker.js";

interface WorkerEnvironment {
  getWorker?: (moduleId: string, label: string) => Worker | Promise<Worker>;
  getWorkerUrl?: (moduleId: string, label: string) => string;
}

export interface DextTypescriptOptions {
  /** Webview URI of the bundled editor worker; the TypeScript worker is a sibling. */
  workerUri?: string;
  /** Types already known at construction time. */
  types?: DextComposerTypes;
  /** Ask the host for the declaration and the workspace's API modules. The host also
   * pushes them; asking means a Webview that missed that message still works. */
  requestTypes?(): void;
  /** The types were applied: the editor clears its "unavailable" signal and the host
   * can log what the composer now knows. */
  onTypesApplied?(counts: { builtins: number; modules: number }): void;
  /** Asking twice produced nothing: the editor says so instead of staying silent. */
  onTypesMissing?(): void;
}

/** How long to wait for an answer before asking again, and before giving up. */
const TYPES_RETRY_MS = 4_000;
const TYPES_MISSING_MS = 10_000;

/** What the composer's TypeScript worker needs to describe the workspace's APIs. */
export interface DextComposerTypes {
  /** The generated `dext` declaration. */
  declaration: string;
  /** The generated project's `dext/api/*` mapping. */
  apiPaths: string[];
  /** The workspace's API sources, keyed by their path under the virtual `.dext` root. */
  modules: { path: string; specifier: string; content: string }[];
}

let requested: Promise<TypescriptContribution> | undefined;

/** The contribution was already evaluated by `./monacoEnvironment.js`, so this
 * only re-reads the cached module namespace.
 *
 * It has to stay *one* namespace: a code-splitting bundler gives this dynamic import
 * its own copy, and the editor's providers would then read one module's defaults while
 * the declaration and compiler options sent by the host are added to the other — a
 * composer whose TypeScript service has never heard of `dext.d.ts`. `esbuild.mjs`
 * bundles the Webview as a single IIFE for exactly that reason, and the Monaco lab
 * builds the same way so it can catch a regression here. */
function contribution(): Promise<TypescriptContribution> {
  requested ??= import("monaco-editor/languages/features/typescript/register.js");
  return requested;
}

function environment(): WorkerEnvironment | undefined {
  return (globalThis as { MonacoEnvironment?: WorkerEnvironment }).MonacoEnvironment;
}

function siblingWorkerUri(workerUri: string, name: string): string {
  const slash = workerUri.lastIndexOf("/");
  if (slash < 0) return name;
  // Keep the cache key the editor's own URL carried, so the worker is the one that
  // belongs to the bundle the editor is running.
  const query = workerUri.indexOf("?", slash);
  return `${workerUri.slice(0, slash + 1)}${name}${query < 0 ? "" : workerUri.slice(query)}`;
}

/** Route Monaco's TypeScript worker to the `ts.worker.js` bundle. Every other
 * label keeps the editor worker the environment already serves. */
function routeTypeScriptWorker(workerUri: string): { dispose(): void } {
  const target = environment();
  const base = target?.getWorker;
  if (!target || !base) return { dispose() {} };
  let prepared: Promise<string> | undefined;
  let blobUrl: string | undefined;
  const workerCode = (): Promise<string> => {
    prepared ??= fetch(siblingWorkerUri(workerUri, DEXT_TYPESCRIPT_WORKER)).then(async (response) => {
      if (!response.ok) throw new Error(`TypeScript worker: HTTP ${response.status}`);
      blobUrl = URL.createObjectURL(new Blob([await response.text()], { type: "text/javascript" }));
      return blobUrl;
    });
    return prepared;
  };
  // Keep a rejected fetch handled until Monaco requests its worker.
  void workerCode().catch(() => undefined);
  target.getWorker = async (moduleId: string, label: string) => {
    if (label === "typescript" || label === "javascript") return new Worker(await workerCode());
    return base(moduleId, label);
  };
  return { dispose() {
    target.getWorker = base;
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  } };
}

/**
 * The worker's compiler options.
 *
 * The generated `.dext/tsconfig.json` is `module: nodenext`,
 * `moduleResolution: nodenext`, `target: es2022`. Monaco's bundled enums do not
 * expose NodeNext or ES2022, so the closest available values are used: the worker
 * still applies strict, erasable-syntax-only TypeScript.
 *
 * `apiPaths` is that project's own `dext/api/*` mapping, resolved against the virtual
 * `.dext` root the API modules are registered under. `setCompilerOptions` replaces the
 * whole object, so this is the single place the options are built.
 */
function compilerOptions(
  module: TypescriptContribution,
  apiPaths: readonly string[]
): Parameters<LanguageServiceDefaults["setCompilerOptions"]>[0] {
  return {
    strict: true,
    noEmit: true,
    module: module.ModuleKind.ESNext,
    moduleResolution: module.ModuleResolutionKind.NodeJs,
    target: module.ScriptTarget.ESNext,
    allowImportingTsExtensions: true,
    erasableSyntaxOnly: true,
    allowNonTsExtensions: true,
    skipLibCheck: true,
    types: [],
    ...(apiPaths.length ? { baseUrl: DEXT_WORKSPACE_PATH, paths: { "dext/api/*": [...apiPaths] } } : {})
  };
}

function configure(defaults: LanguageServiceDefaults, module: TypescriptContribution, apiPaths: readonly string[] = []): void {
  defaults.setCompilerOptions(compilerOptions(module, apiPaths));
  defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
  defaults.setEagerModelSync(true);
}

/**
 * Install TypeScript support for the composer and start listening for the host's
 * `dextTypes` message. Returns a disposer that removes the listener, the extra
 * libraries, the completion provider and the worker routing.
 */
export function installDextTypescript(options: DextTypescriptOptions = {}): { dispose(): void } {
  const routing = options.workerUri ? routeTypeScriptWorker(options.workerUri) : { dispose() {} };
  let libraries: { dispose(): void }[] = [];
  let hasTypes = false;
  let builtins = 0;
  let modules = 0;
  let symbols: DextSymbol[] = [];
  let disposed = false;
  let applied = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let missing: ReturnType<typeof setTimeout> | undefined;

  const applyTypes = (defaults: LanguageServiceDefaults, module: TypescriptContribution, types: DextComposerTypes): void => {
    if (disposed) return;
    applied = true;
    if (retry !== undefined) clearTimeout(retry);
    if (missing !== undefined) clearTimeout(missing);
    retry = undefined;
    missing = undefined;
    for (const library of libraries) library.dispose();
    libraries = [
      defaults.addExtraLib(types.declaration, DEXT_DECLARATION_PATH),
      // The workspace's own APIs, so `import { main } from "dext/api/git/commit"`
      // resolves and completes here the way it does in `.dext/api/*.ts`.
      ...types.modules.map((source) => defaults.addExtraLib(source.content, `${DEXT_WORKSPACE_PATH}/${source.path}`))
    ];
    hasTypes = true;
    builtins = dextBuiltinNames(types.declaration).length;
    modules = types.modules.length;
    // Monaco's worker cannot report unimported exports, so the names to offer come from
    // the same sources, read here rather than guessed from a name's shape.
    symbols = dextApiSymbols(types.declaration, types.modules);
    // The composer's view of the workspace is otherwise invisible, and the Webview
    // console is where a missing API module gets diagnosed.
    console.debug(`[dext] composer types: ${builtins} built-in name(s), ${modules} API module(s)`);
    configure(defaults, module, types.apiPaths);
    options.onTypesApplied?.({ builtins, modules });
  };

  const onMessage = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (!data || typeof data !== "object") return;
    const message = data as Partial<DextComposerTypes> & { type?: unknown };
    if (message.type !== "dextTypes" || typeof message.declaration !== "string") return;
    const types: DextComposerTypes = {
      declaration: message.declaration,
      apiPaths: Array.isArray(message.apiPaths) ? message.apiPaths.filter((entry): entry is string => typeof entry === "string") : [],
      modules: Array.isArray(message.modules)
        ? message.modules.filter((module): module is DextComposerTypes["modules"][number] =>
          !!module && typeof module.path === "string" && typeof module.specifier === "string" && typeof module.content === "string")
        : []
    };
    void contribution().then((module) => applyTypes(module.typescriptDefaults, module, types));
  };
  window.addEventListener("message", onMessage);

  // Nothing here invents a name: an API is imported, and what is offered is an export the
  // sources actually have — inside `import { … }` the module's own exports, everywhere else
  // an unimported one written together with the import that binds it, which is what VS
  // Code's TypeScript service does and Monaco's worker cannot (`getCompletionsAtPosition`
  // runs without `includeCompletionsForModuleExports`). A name like `git` is not an export
  // of anything, so it completes nothing.
  //
  // The selector names the language as well as the scheme: the composer's language *is*
  // its mode (code is TypeScript, every other mode is plain text), and a prompt written in
  // Agent or Chat mode has no business offering TypeScript symbols. Matching the scheme
  // alone is what made the widget appear there.
  const completion = monaco.languages.registerCompletionItemProvider({ scheme: DEXT_COMPOSER_SCHEME, language: "typescript" }, {
    provideCompletionItems: (model, position) => {
      const line = model.getLineContent(position.lineNumber);
      const typed = /[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\.?$/.exec(line.slice(0, position.column - 1))?.[0] ?? "";
      const notice = dextTypesNotice(typed, { line: position.lineNumber, column: position.column }, hasTypes);
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: Math.max(1, position.column - typed.length),
        endLineNumber: position.lineNumber,
        endColumn: position.column
      };
      const suggestions: monaco.languages.CompletionItem[] = [];
      if (notice) suggestions.push({ ...notice, kind: monaco.languages.CompletionItemKind.Text });
      for (const symbol of dextSymbolsFor(typed, text, offset, symbols)) {
        const inImport = dextImportTargetAt(text, offset) !== undefined;
        suggestions.push({
          label: symbol.name,
          kind: symbolKind(symbol.kind),
          detail: inImport ? `from "${symbol.specifier}"` : `Auto import from "${symbol.specifier}"`,
          insertText: symbol.name,
          filterText: symbol.name,
          range,
          additionalTextEdits: inImport ? [] : [dextImportEdit(symbol)]
        });
      }
      return { suggestions };
    }
  });

  void contribution().then((module) => {
    configure(module.typescriptDefaults, module, options.types?.apiPaths ?? []);
    if (options.types) applyTypes(module.typescriptDefaults, module, options.types);
  });

  // Ask now, ask once more, and then say so. A pushed message that never arrives leaves
  // an editor with no declaration, no API modules and no completion — and no visible
  // reason, which is exactly how a stale Webview bundle presents itself.
  if (options.requestTypes && !options.types) {
    options.requestTypes();
    retry = setTimeout(() => { if (!applied && !disposed) options.requestTypes?.(); }, TYPES_RETRY_MS);
    missing = setTimeout(() => { if (!applied && !disposed) options.onTypesMissing?.(); }, TYPES_MISSING_MS);
  }

  return { dispose() {
    disposed = true;
    if (retry !== undefined) clearTimeout(retry);
    if (missing !== undefined) clearTimeout(missing);
    window.removeEventListener("message", onMessage);
    completion.dispose();
    for (const library of libraries) library.dispose();
    libraries = [];
    routing.dispose();
  } };
}
