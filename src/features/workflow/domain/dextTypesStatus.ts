/**
 * The Composer's TypeScript support, as little of it as there is to say.
 *
 * Code mode is plain TypeScript: the generated declaration is registered as a library
 * and the workspace's own API modules resolve through the project's `dext/api/*`
 * mapping, so `import { main } from "dext/api/git/commit"` completes, hovers and
 * diagnoses exactly like any other module. Nothing here completes an API *for* the
 * user: a name that was never imported is an error in TypeScript, and `git.commit()`
 * is a mistake the editor is supposed to show, not translate.
 *
 * What is left is the one thing TypeScript cannot say for itself: whether the
 * declaration arrived at all. A composer with no types answers every name with a silent
 * "No suggestions.", which is indistinguishable from a Webview running an older bundle,
 * so the notice says which it is.
 */

/** The completion shown when the composer has no declaration and no API modules. */
export interface DextTypesNotice {
  label: string;
  filterText: string;
  detail: string;
  insertText: string;
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  additionalTextEdits: [];
}

/**
 * The notice for a caret on `typed`, or undefined when the composer has its types.
 *
 * `insertText` repeats what was typed, so accepting the notice changes nothing.
 */
export function dextTypesNotice(
  typed: string,
  position: { line: number; column: number },
  hasTypes: boolean
): DextTypesNotice | undefined {
  if (hasTypes || !typed) return undefined;
  return {
    label: "Dext types not loaded",
    // Filtered by what was typed, so the notice survives the filter that would
    // otherwise hide it.
    filterText: typed,
    detail: "The input is running an older Webview bundle than the extension. Run \"Developer: Reload Window\".",
    insertText: typed,
    range: {
      startLineNumber: position.line,
      startColumn: Math.max(1, position.column - typed.length),
      endLineNumber: position.line,
      endColumn: position.column
    },
    additionalTextEdits: []
  };
}

/** The names a generated declaration exports, for the host's `Dext Input` log. */
export function dextBuiltinNames(declaration: string): string[] {
  const names = new Set<string>();
  for (const match of declaration.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) names.add(match[1]!);
  for (const match of declaration.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) names.add(match[1]!);
  return [...names].sort();
}
