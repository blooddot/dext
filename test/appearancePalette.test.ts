import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MONACO_COLOR_IDS } from "../src/webview/monacoThemeRules.js";

/**
 * Paper and Dim are self-contained palettes, but Monaco 0.56 paints its widgets from
 * `--vscode-*` CSS variables: every id the palette leaves out is painted with the
 * user's own workbench theme instead, which is how cream rows kept ending up with the
 * dark theme's white text. Guard both blocks so the next gap fails here instead of in
 * a screenshot.
 */
const MONACO = "node_modules/monaco-editor/esm/vs";

/** The Monaco features the Dext editor loads. The rest of the package (diff, peek,
 * inline edit, sticky scroll) never renders here and needs no palette entry. */
const MONACO_CHROME = [
  "editor/contrib/suggest",
  "editor/contrib/hover",
  "editor/contrib/parameterHints",
  "editor/contrib/find",
  "editor/contrib/snippet",
  "editor/contrib/wordHighlighter",
  "editor/contrib/bracketMatching",
  "editor/contrib/codeAction",
  "editor/contrib/contextmenu",
  "editor/contrib/symbolIcons",
  "base/browser/ui/scrollbar",
  "base/browser/ui/list"
];

/** Null in every light and dark theme, so no variable means the same paint. */
const UNPAINTED = new Set([
  "editor-findMatchBorder",
  "editor-selectionHighlightBorder",
  "editor-snippetTabstopHighlightBorder",
  "editor-snippetFinalTabstopHighlightBackground",
  "editor-wordHighlightBorder",
  "editor-wordHighlightStrongBorder",
  "editor-wordHighlightTextBorder",
  "editorWidget-resizeBorder",
  "scrollbar-background"
]);

/** Sizes, fonts and shadow spreads: dimensions belong to the workbench, not a palette. */
const NOT_A_COLOUR = /(FontFamily|fontFamily|Font|font|FeatureSettings|Width|whiteSpace|sourceWhiteSpace|lineHeight|min-width|size|content|Default)$|^(icon|shadow|cornerRadius|sash|hover)-/;

/** Left to Monaco's own theme defaults on purpose: the palette sets the upstream id
 * these derive from (`editorWidget.background`, `list.activeSelectionForeground`,
 * `list.highlightForeground`), or stays out of the way entirely. */
const MONACO_DEFAULT = /^(symbolIcon-|scrollbar|editorSuggestWidget|editorHoverWidget)/;

const css = readFileSync("media/appearance.css", "utf8");

function palette(theme: "paper" | "dim"): Set<string> {
  const selector = `body[data-dext-theme="${theme}"]:not(.vscode-high-contrast):not(.vscode-high-contrast-light) {`;
  const start = css.indexOf(selector);
  expect(start, `${theme} block`).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n}", start));
  return new Set([...block.matchAll(/(--vscode-[\w-]+):/g)].map((match) => match[1]!));
}

function files(dir: string): string[] {
  return readdirSync(join(MONACO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(MONACO, dir, entry.name);
    if (entry.isDirectory()) return files(join(dir, entry.name));
    return /\.(css|js)$/.test(entry.name) ? [path] : [];
  });
}

/** Every `--vscode-*` variable id the loaded Monaco features read. */
function paintedIds(): Set<string> {
  const painted = new Set<string>();
  for (const file of MONACO_CHROME.flatMap(files)) {
    for (const [, id] of readFileSync(file, "utf8").matchAll(/--vscode-([\w-]+)/g)) painted.add(id!);
  }
  return painted;
}

describe("Paper and Dim palettes", () => {
  const paper = palette("paper");
  const dim = palette("dim");

  it("define the same variables, so neither drifts into the workbench theme alone", () => {
    expect([...paper].sort()).toEqual([...dim].sort());
  });

  it("colour every Monaco surface the editor actually paints", () => {
    const missing = [...paintedIds()]
      .filter((id) => !UNPAINTED.has(id) && !NOT_A_COLOUR.test(id) && !MONACO_DEFAULT.test(id) && !paper.has(`--vscode-${id}`))
      .sort();
    expect(missing).toEqual([]);
  });

  it("hands those colours to Monaco as theme colors, not only as body variables", () => {
    // Monaco re-declares each registered color on `.monaco-editor`, which shadows the
    // palette's body scope: a palette entry missing from MONACO_COLOR_IDS is painted
    // with Monaco's base theme (white focused suggest rows) instead of Paper.
    const routed = new Set(MONACO_COLOR_IDS.map((id) => id.replaceAll(".", "-")));
    const missing = [...paintedIds()]
      .filter((id) => !UNPAINTED.has(id) && !NOT_A_COLOUR.test(id) && paper.has(`--vscode-${id}`) && !routed.has(id))
      .sort();
    expect(missing).toEqual([]);
  });

  it("colour every id Monaco copies from the variables into its own theme", () => {
    const missing = MONACO_COLOR_IDS
      .filter((id) => !paper.has(`--vscode-${id.replaceAll(".", "-")}`))
      .sort();
    expect(missing).toEqual([]);
  });
});
