import { describe, expect, it } from "vitest";
import {
  dextApiSymbols, dextBoundNames, dextImportEdit, dextImportTargetAt, dextSymbolsFor
} from "../src/webview/dextApiSymbols.js";

const declaration = [
  'declare module "dext" {',
  "  export interface AskResult {",
  '    kind: "ask";',
  "  }",
  "  export function ask(options: { input: string }): Promise<AskResult>;",
  "  export const mcp: { [server: string]: unknown };",
  "}"
].join("\n");
const commit = {
  specifier: "dext/api/git/commit",
  content: [
    "export async function commit(message: string): Promise<string> {",
    "  return message;",
    "}",
    "export type CommitOptions = { amend?: boolean };"
  ].join("\n")
};

/**
 * Monaco's TypeScript worker completes without `includeCompletionsForModuleExports`, so it
 * never reports a symbol that is not already in scope: without these names, typing `ask`
 * or `commit` in Code mode offered nothing at all, while VS Code's own service offers the
 * export together with the import that binds it. The names are read out of the sources the
 * host already sends, so only real exports are ever offered — `git` is a directory, not a
 * symbol, and still completes nothing.
 */
describe("the composer's importable symbols", () => {
  it("reads the declaration and every API module, keeping the first exporter", () => {
    const symbols = dextApiSymbols(declaration, [commit, { specifier: "dext/api/git/status", content: 'export const ask = 1;\nexport function status(): void {}' }]);
    expect(symbols.map((symbol) => [symbol.name, symbol.specifier])).toEqual([
      ["AskResult", "dext"],
      ["CommitOptions", "dext/api/git/commit"],
      ["ask", "dext"],
      ["commit", "dext/api/git/commit"],
      ["mcp", "dext"],
      ["status", "dext/api/git/status"]
    ]);    expect(symbols.find((symbol) => symbol.name === "ask")!.kind).toBe("function");
    expect(symbols.find((symbol) => symbol.name === "CommitOptions")!.kind).toBe("interface");
    expect(symbols.find((symbol) => symbol.name === "mcp")!.kind).toBe("constant");
  });

  it("reads re-exports and never mistakes `const enum` for a constant called `enum`", () => {
    const symbols = dextApiSymbols("", [
      { specifier: "dext/api/a", content: "export const enum Mode { A }\nexport { helper as run, other } from \"./helper.js\";" }
    ]);
    expect(symbols.map((symbol) => [symbol.name, symbol.kind])).toEqual([
      ["Mode", "enum"],
      ["other", "constant"],
      ["run", "constant"]
    ]);
  });

  it("knows what the buffer already binds", () => {
    const bound = dextBoundNames([
      'import { ask, type AskResult } from "dext";',
      'import type { CommitOptions } from "dext/api/git/commit";',
      'import * as helpers from "./helpers.js";',
      'import defaultExport, { commit as run } from "dext/api/git/commit";',
      "const local = 1;",
      "async function later(): Promise<void> {}"
    ].join("\n"));
    expect([...bound].sort()).toEqual([
      "AskResult", "CommitOptions", "ask", "defaultExport", "helpers", "later", "local", "run"
    ].sort());
  });

  it("finds the module whose import braces the caret is in", () => {
    const text = 'import { commi } from "dext/api/git/commit";\nconst other = 1;\n';
    expect(dextImportTargetAt(text, text.indexOf("commi") + 5)).toBe("dext/api/git/commit");
    expect(dextImportTargetAt(text, text.indexOf("const"))).toBeUndefined();
  });

  it("offers an unimported export with its import, and nothing for a directory name", () => {
    const symbols = dextApiSymbols(declaration, [commit]);
    const bare = "commi";
    // What was typed in its own case comes first; the type the same prefix reaches, after.
    expect(dextSymbolsFor("commi", bare, bare.length, symbols)).toEqual([
      { name: "commit", specifier: "dext/api/git/commit", kind: "function" },
      { name: "CommitOptions", specifier: "dext/api/git/commit", kind: "interface" }
    ]);
    expect(dextSymbolsFor("ask", "ask", 3, symbols)).toEqual([
      { name: "ask", specifier: "dext", kind: "function" },
      { name: "AskResult", specifier: "dext", kind: "interface" }
    ]);
    // `git` is not exported by anything, so the old `.dx` habit still completes nothing.
    expect(dextSymbolsFor("git", "git", 3, symbols)).toEqual([]);
    expect(dextSymbolsFor("", "", 0, symbols)).toEqual([]);
  });

  it("offers the module's own exports inside its import, without an import edit", () => {
    const symbols = dextApiSymbols(declaration, [commit]);
    const text = 'import { commi } from "dext/api/git/commit";';
    const matches = dextSymbolsFor("commi", text, text.indexOf("commi") + 5, symbols);
    expect(matches.map((symbol) => symbol.name)).toEqual(["commit", "CommitOptions"]);
    // Nothing from another module is dragged into the import being written.
    expect(matches.some((symbol) => symbol.name === "ask")).toBe(false);
  });

  it("skips what the buffer already binds", () => {
    const symbols = dextApiSymbols(declaration, [commit]);
    const imported = 'import { ask } from "dext";\nask';
    const unbound = dextSymbolsFor("ask", imported, imported.length, symbols);
    expect(unbound.some((symbol) => symbol.name === "ask")).toBe(false);
    expect(unbound.map((symbol) => symbol.name)).toEqual(["AskResult"]);
    const declared = "const commit = 1;\ncommi";
    expect(dextSymbolsFor("commi", declared, declared.length, symbols).map((symbol) => symbol.name))
      .toEqual(["CommitOptions"]);
  });

  it("writes the import the kernel resolves, at the top of the buffer", () => {
    expect(dextImportEdit({ name: "commit", specifier: "dext/api/git/commit", kind: "function" })).toEqual({
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
      text: 'import { commit } from "dext/api/git/commit";\n'
    });
  });
});
