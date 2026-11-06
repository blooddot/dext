/**
 * The exported names the composer offers to import.
 *
 * Monaco's TypeScript worker answers completion without preferences
 * (`SuggestAdapter` calls `getCompletionsAtPosition(resource, offset)` and `tsWorker`
 * passes `void 0` to the service), so `includeCompletionsForModuleExports` is always off:
 * the editor never reports a symbol that is not already in scope. That is the one place
 * where the composer could not behave like VS Code's own TypeScript service — typing
 * `commit` or `ask` offered nothing at all — because VS Code *does* complete an unimported
 * export together with the import that binds it.
 *
 * The names here come from the sources the host already sends for the worker: the
 * generated `dext` declaration and the workspace's API modules. They are read, never
 * guessed — `git` is not an export of anything, so typing it still completes nothing, and
 * a symbol is only offered with the import statement the kernel would resolve.
 */

export type DextSymbolKind = "function" | "constant" | "class" | "interface" | "enum";

export interface DextSymbol {
  name: string;
  /** The module the symbol is imported from, as the kernel resolves it. */
  specifier: string;
  kind: DextSymbolKind;
}

/** The specifier the built-in APIs live in. */
export const DEXT_DECLARATION_SPECIFIER = "dext";

/** How many symbols one keystroke may offer, so a large declaration stays usable. */
const SYMBOL_LIMIT = 50;

const EXPORTS: { pattern: RegExp; kind: DextSymbolKind }[] = [
  { pattern: /\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g, kind: "function" },
  // `const enum` is an enum, not a constant called `enum`.
  { pattern: /\bexport\s+(?:const|let|var)\s+(?!enum\b)([A-Za-z_$][\w$]*)/g, kind: "constant" },
  { pattern: /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, kind: "class" },
  { pattern: /\bexport\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/g, kind: "interface" },
  { pattern: /\bexport\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g, kind: "enum" }
];

/** `export { a, b as c }` exports `a` and `c`. */
function reExportNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const entry of match[1]!.split(",")) {
      const [exported, alias] = entry.trim().split(/\s+as\s+/);
      const name = (alias ?? exported ?? "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  return names;
}

function exportedNames(source: string): { name: string; kind: DextSymbolKind }[] {
  const found = new Map<string, DextSymbolKind>();
  for (const { pattern, kind } of EXPORTS) {
    for (const match of source.matchAll(pattern)) {
      if (!found.has(match[1]!)) found.set(match[1]!, kind);
    }
  }
  for (const name of reExportNames(source)) found.set(name, found.get(name) ?? "constant");
  return [...found].map(([name, kind]) => ({ name, kind }));
}

/**
 * Every symbol the composer could import: the built-ins first, then each API module's own
 * exports. A name is kept once — the first module that exports it is the one the import
 * names, which is the order the kernel's own "you forgot the import" hint uses.
 */
export function dextApiSymbols(
  declaration: string,
  modules: readonly { specifier: string; content: string }[]
): DextSymbol[] {
  const symbols = new Map<string, DextSymbol>();
  const add = (name: string, specifier: string, kind: DextSymbolKind): void => {
    if (!symbols.has(name)) symbols.set(name, { name, specifier, kind });
  };
  for (const { name, kind } of exportedNames(declaration)) add(name, DEXT_DECLARATION_SPECIFIER, kind);
  for (const module of modules) {
    for (const { name, kind } of exportedNames(module.content)) add(name, module.specifier, kind);
  }
  return [...symbols.values()].sort(byName);
}

/** Locale-independent, so the order is the same everywhere and in every test. */
function byName(left: DextSymbol, right: DextSymbol): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** The names the buffer already binds: its imports and its own declarations. */
export function dextBoundNames(text: string): Set<string> {
  const bound = new Set<string>();
  for (const match of text.matchAll(/\bimport\s+(?:type\s+)?([\s\S]*?)\bfrom\s*["'][^"']+["']/g)) {
    for (const raw of match[1]!.split(",")) {
      // `{ a, b as c }` binds `c`, `* as c` binds `c`, and `import X` binds `X`.
      const entry = raw.replace(/[{}*]/g, " ").trim().replace(/^type\s+/, "");
      const name = (/\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(entry)?.[1] ?? entry).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }
  for (const match of text.matchAll(/\b(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
    bound.add(match[1]!);
  }
  return bound;
}

/**
 * The module whose `import { … } from "…"` braces the caret sits in, if any. Inside those
 * braces the import already exists, so the module's own exports are offered without an
 * edit; everywhere else an unimported export is offered with its import.
 */
export function dextImportTargetAt(text: string, offset: number): string | undefined {
  for (const match of text.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const start = match.index + match[0].indexOf("{") + 1;
    const end = start + match[1]!.length;
    if (offset >= start && offset <= end) return match[2]!;
  }
  return undefined;
}

function prefixed(name: string, typed: string): boolean {
  return name.toLowerCase().startsWith(typed.toLowerCase());
}

/**
 * The symbols to offer for `typed`, given the buffer and where the caret is in it.
 *
 * Inside an existing import the target module's exports are offered; anywhere else the
 * names that are not bound yet are offered together with the import that binds them —
 * unless a declaration of the same name is already in the buffer, where an import would
 * be a duplicate-identifier error rather than a fix.
 */
export function dextSymbolsFor(
  typed: string,
  text: string,
  offset: number,
  symbols: readonly DextSymbol[],
  limit = SYMBOL_LIMIT
): DextSymbol[] {
  if (!typed) return [];
  const target = dextImportTargetAt(text, offset);
  const bound = target === undefined ? dextBoundNames(text) : undefined;
  const matches = symbols.filter((symbol) =>
    prefixed(symbol.name, typed) &&
    (target === undefined ? !bound!.has(symbol.name) : symbol.specifier === target));
  // What was typed in the case it was typed comes first; `ask` offering `AskResult` after
  // it is how Monaco filters too.
  const rank = (symbol: DextSymbol): number => (symbol.name.startsWith(typed) ? 0 : 1);
  return matches.sort((left, right) => rank(left) - rank(right) || byName(left, right)).slice(0, limit);
}

/** The edit that inserts the import for a symbol at the top of the buffer. */
export function dextImportEdit(symbol: DextSymbol): {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
} {
  return {
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    text: `import { ${symbol.name} } from "${symbol.specifier}";\n`
  };
}
