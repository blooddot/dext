import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
  configuration: new Map<string, unknown>(),
  extensions: [] as { extensionPath: string; packageJSON: unknown }[],
  themeKind: 2
}));

vi.mock("vscode", () => ({
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  extensions: {
    get all() { return vscodeState.extensions; }
  },
  window: {
    activeColorTheme: {
      get kind() { return vscodeState.themeKind; }
    }
  },
  workspace: {
    getConfiguration(section?: string) {
      return {
        get<T>(key: string, fallback?: T): T | undefined {
          const qualified = section ? `${section}.${key}` : key;
          return vscodeState.configuration.has(qualified)
            ? vscodeState.configuration.get(qualified) as T
            : fallback;
        }
      };
    }
  }
}));

import { loadEditorTokenTheme } from "../src/vscodeTheme.js";

let directory: string;

function addTheme(id: string, path: string): void {
  vscodeState.extensions.push({
    extensionPath: directory,
    packageJSON: { contributes: { themes: [{ id, label: id, path }] } }
  });
}

describe("VS Code TextMate theme adapter", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dext-theme-"));
    mkdirSync(join(directory, "themes"));
    vscodeState.configuration.clear();
    vscodeState.extensions = [];
    vscodeState.themeKind = 2;
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("merges JSONC includes and applies token customizations with TextMate specificity", () => {
    writeFileSync(join(directory, "themes", "base.json"), JSON.stringify({
      tokenColors: [
        { scope: "variable", settings: { foreground: "#111111" } },
        { scope: "variable.other.constant", settings: { foreground: "#222222" } },
        { scope: "entity.name.function", settings: { foreground: "#333333" } },
        { scope: "constant.language.boolean", settings: { foreground: "#444444" } },
        { scope: "punctuation", settings: { foreground: "#555555" } }
      ]
    }));
    writeFileSync(join(directory, "themes", "active.jsonc"), `{
      // Project theme overrides its included base.
      "include": "./base.json",
      "tokenColors": [
        { "scope": "variable.other.property", "settings": { "foreground": "#666666" } }
      ]
    }`);
    addTheme("Project Theme", "./themes/active.jsonc");
    vscodeState.configuration.set("workbench.colorTheme", "Project Theme");
    vscodeState.configuration.set("editor.tokenColorCustomizations", {
      strings: "#777777",
      "[Project Theme]": { keywords: "#888888" }
    });

    expect(loadEditorTokenTheme()).toMatchObject({
      variable: "#111111",
      property: "#666666",
      function: "#333333",
      boolean: "#444444",
      punctuation: "#555555",
      string: "#777777",
      keyword: "#888888"
    });
  });

  it("uses the preferred theme when automatic color-scheme detection is active", () => {
    writeFileSync(join(directory, "themes", "preferred.json"), JSON.stringify({
      tokenColors: [{ scope: "string", settings: { foreground: "#abcdef" } }]
    }));
    addTheme("Preferred Dark", "./themes/preferred.json");
    vscodeState.configuration.set("workbench.colorTheme", "Other Theme");
    vscodeState.configuration.set("window.autoDetectColorScheme", true);
    vscodeState.configuration.set("workbench.preferredDarkColorTheme", "Preferred Dark");

    expect(loadEditorTokenTheme()).toMatchObject({ string: "#abcdef" });
  });
});
