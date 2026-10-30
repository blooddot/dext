import { describe, expect, it } from "vitest";
import {
  COMPOSER_GLOBAL_API_DIRECTORY,
  COMPOSER_GLOBAL_API_PATHS,
  composerApiId,
  composerGlobalApiModules
} from "../src/features/workflow/domain/composerApiModules.js";
import { dextApiSymbols, dextSymbolsFor } from "../src/webview/dextApiSymbols.js";

const project = {
  path: "api/git/status.ts",
  specifier: "dext/api/git/status",
  content: "export function status(): void {}"
};

/**
 * The generated project cannot map Dext's global storage, because a committed
 * `tsconfig.json` must not name a machine-local path. The composer still has to type
 * those APIs: it registers them under one virtual directory whose candidates follow
 * the project's own, so the kernel's search order survives in the editor.
 */
describe("the composer's global API modules", () => {
  it("appends one virtual directory after the project's own candidates", () => {
    expect(COMPOSER_GLOBAL_API_PATHS).toEqual([
      `./${COMPOSER_GLOBAL_API_DIRECTORY}/*.ts`,
      `./${COMPOSER_GLOBAL_API_DIRECTORY}/*.mts`,
      `./${COMPOSER_GLOBAL_API_DIRECTORY}/*/index.ts`
    ]);
  });

  it("derives the import id the kernel resolves, including a directory index", () => {
    expect(composerApiId("git/commit.ts")).toBe("git/commit");
    expect(composerApiId("git\\commit.mts")).toBe("git/commit");
    expect(composerApiId("git/commit/index.ts")).toBe("git/commit");
  });

  it("registers a global module under the virtual root with its import specifier", () => {
    expect(composerGlobalApiModules([project], [{
      relative: "git/commit.ts",
      content: "export function commit(): void {}"
    }])).toEqual([{
      path: `${COMPOSER_GLOBAL_API_DIRECTORY}/git/commit.ts`,
      specifier: "dext/api/git/commit",
      content: "export function commit(): void {}"
    }]);
  });

  it("keeps the project module when both roots answer the same id", () => {
    const modules = composerGlobalApiModules([{
      path: "api/git/commit.ts",
      specifier: "dext/api/git/commit",
      content: "export function commit(): void {}"
    }], [{ relative: "git/commit.ts", content: "export function commit(): void {}" }]);
    expect(modules).toEqual([]);
  });

  it("lets a project index claim its directory id", () => {
    const modules = composerGlobalApiModules([{
      path: "api/git/commit/index.ts",
      specifier: "dext/api/git/commit/index",
      content: "export function commit(): void {}"
    }], [{ relative: "git/commit.ts", content: "export function commit(): void {}" }]);
    expect(modules).toEqual([]);
  });

  it("prefers the source the kernel would pick, then drops the duplicate id", () => {
    const modules = composerGlobalApiModules([project], [
      { relative: "git/commit.mts", content: "export function second(): void {}" },
      { relative: "git/commit.ts", content: "export function first(): void {}" }
    ]);
    expect(modules.map((module) => [module.path, module.specifier])).toEqual([
      [`${COMPOSER_GLOBAL_API_DIRECTORY}/git/commit.ts`, "dext/api/git/commit"]
    ]);
  });

  it("offers the global export with the import the kernel resolves", () => {
    const modules = composerGlobalApiModules([], [{
      relative: "git/commit.ts",
      content: "export async function commit(): Promise<void> {}"
    }]);
    const symbols = dextApiSymbols("", modules);
    expect(dextSymbolsFor("commit", "commit", 4, symbols)).toEqual([
      { name: "commit", specifier: "dext/api/git/commit", kind: "function" }
    ]);
  });
});
