import type { EditorTokenName, EditorTokenTheme } from "../shared/contracts/theme.js";

/**
 * The Monaco half of the theme: the active VS Code theme read as token colors, turned
 * into the rules Monaco paints with.
 *
 * Monaco matches a rule against a token type by its dot-separated prefix, and Monaco's
 * TypeScript tokenizer emits far fewer types than TextMate has scopes: `keyword`,
 * `identifier`, `string`, `number`, `comment`, `regexp`, `type.identifier` and the
 * `delimiter*` family. Only mapping the value types left every name, brace, parenthesis
 * and semicolon on Monaco's own default color, which is why the composer looked like a
 * different theme from the editor next to it.
 */

export interface DextThemeRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

/** Monaco token type → the theme slot that paints it. */
const TOKENS: readonly (readonly [string, EditorTokenName])[] = [
  ["keyword", "keyword"],
  ["string", "string"],
  ["number", "number"],
  ["regexp", "regexp"],
  ["comment", "comment"],
  ["type", "type"],
  ["identifier", "identifier"],
  ["delimiter", "delimiter"],
  ["operator", "operator"],
  ["variable", "variable"],
  ["property", "property"],
  // The TypeScript grammar reaches these through the value types.
  ["tag", "type"],
  ["annotation", "function"],
  // The CSS, HTML and YAML grammars name their tokens after VS Code scopes the
  // composer never emits; map them onto the same slots so fenced code follows the
  // active theme instead of Monaco's built-in default.
  ["attribute.name", "property"],
  ["attribute.value", "string"],
  ["key", "property"],
  ["metatag", "keyword"]
];

/** `color-mix(in srgb, foreground <weight>, background)` as the RRGGBB Monaco
 * needs for its default token. The composer's prose is dimmer than a full
 * editor's foreground so it matches the conversation body beside it. */
export function mixDefaultForeground(foreground: string, background: string, weight: number): string | undefined {
  const fg = monacoColor(foreground);
  const bg = monacoColor(background);
  if (!fg || !bg) return undefined;
  const channel = (hex: string, index: number): number => parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return [0, 1, 2]
    .map((index) => Math.round(channel(fg, index) * weight + channel(bg, index) * (1 - weight)).toString(16).padStart(2, "0"))
    .join("");
}

/** `#rgb`, `#rrggbb` and `#rrggbbaa` are what themes write; Monaco wants `RRGGBB`. */
export function monacoColor(value: string): string | undefined {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return [...hex].map((part) => part + part).join("");
  if (/^[0-9a-f]{4}$/i.test(hex)) return [...hex].map((part) => part + part).join("");
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex) ? hex : undefined;
}

/** Monaco token type → the palette variable that paints it in Paper and Dim. */
const PALETTE: readonly (readonly [EditorTokenName, string])[] = [
  ["keyword", "--resource-syntax-keyword"],
  ["string", "--resource-syntax-string"],
  ["regexp", "--resource-syntax-string"],
  ["number", "--resource-syntax-number"],
  ["boolean", "--resource-syntax-boolean"],
  ["function", "--resource-syntax-function"],
  ["type", "--resource-syntax-type"],
  ["property", "--resource-syntax-parameter"],
  ["comment", "--vscode-descriptionForeground"],
  ["identifier", "--vscode-editor-foreground"],
  ["variable", "--vscode-editor-foreground"],
  ["operator", "--vscode-editor-foreground"],
  ["punctuation", "--vscode-editor-foreground"],
  ["delimiter", "--vscode-editor-foreground"]
];

/**
 * Paper and Dim are self-contained palettes, so the workbench's own token colors are
 * tuned for a background they are no longer painting: they read pastel on cream. These
 * palettes already carry their own syntax colors for the resource pages, so code uses
 * them too, and only the font styles (italic comments) come from the workbench theme.
 */
export function paletteTokenTheme(
  css: { getPropertyValue(name: string): string },
  host: EditorTokenTheme | undefined
): EditorTokenTheme {
  const theme: EditorTokenTheme = {};
  for (const [name, variable] of PALETTE) {
    const foreground = css.getPropertyValue(variable).trim();
    const fontStyle = host?.[name]?.fontStyle;
    theme[name] = {
      ...(foreground ? { foreground } : {}),
      ...(fontStyle ? { fontStyle } : {})
    };
  }
  return theme;
}

/**
 * Colors Monaco reads from the `--vscode-*` variables rather than from its own theme
 * object: widget chrome, and the decorations its renderer paints itself (selection,
 * symbol and search matches, bracket and snippet highlights). Both lists are the same
 * palette, they just reach Monaco through its two color channels.
 *
 * Monaco re-declares every registered color as a `--vscode-*` variable on
 * `.monaco-editor` and `.monaco-component` themselves, and a variable declared on an
 * element wins over whatever the palette sets on the body. So an id Monaco reads but
 * this list leaves out is painted with Monaco's own base `vs` colors — white text on
 * the focused suggest row — no matter what Paper says.
 *
 * Only the ids a color cannot be derived from are listed. Monaco's registry derives
 * most widget colors from a handful of roots (`editorWidget.background` paints the
 * suggest and hover popups, `list.activeSelectionForeground` the focused row,
 * `list.highlightForeground` the match highlight), so setting the root like VS Code's
 * own themes do is enough; the rest — symbol icons, scrollbars — keep Monaco's
 * defaults. `appearancePalette.test.ts` keeps the palette and this list in step.
 */
export const MONACO_COLOR_IDS: readonly string[] = [
  "textLink.foreground", "textCodeBlock.background", "widget.border", "contrastBorder", "focusBorder",
  "editor.background", "editor.foreground", "editorCursor.foreground", "editorGutter.background",
  "editorLineNumber.foreground", "editorLineNumber.activeForeground",
  "editor.selectionBackground", "editor.inactiveSelectionBackground", "editor.lineHighlightBackground",
  "editor.selectionHighlightBackground", "editor.wordHighlightBackground", "editor.wordHighlightStrongBackground",
  "editor.wordHighlightTextBackground", "editor.findMatchBackground", "editor.findMatchHighlightBackground",
  "editor.findRangeHighlightBackground", "editor.hoverHighlightBackground",
  "editorBracketMatch.background", "editorBracketMatch.border",
  "editor.snippetTabstopHighlightBackground", "editor.snippetFinalTabstopHighlightBorder",
  "editorWidget.background", "editorWidget.foreground", "editorWidget.border",
  "list.activeSelectionBackground", "list.activeSelectionForeground", "list.highlightForeground",
  "editorLightBulb.foreground", "editorLightBulbAi.foreground", "editorLightBulbAutoFix.foreground",
  "toolbar.hoverBackground",
  "foreground", "disabledForeground", "errorForeground", "textLink.activeForeground",
  "symbolIcon.keywordForeground", "symbolIcon.stringForeground", "symbolIcon.numberForeground",
  "symbolIcon.booleanForeground", "symbolIcon.propertyForeground", "symbolIcon.methodForeground",
  "symbolIcon.functionForeground", "symbolIcon.classForeground", "symbolIcon.variableForeground",
  "editorError.foreground", "editorWarning.foreground", "editorInfo.foreground"
];

export function monacoThemeRules(theme: EditorTokenTheme | undefined): DextThemeRule[] {
  if (!theme) return [];
  return TOKENS.flatMap(([token, slot]) => {
    const style = theme[slot];
    if (!style) return [];
    const foreground = style.foreground ? monacoColor(style.foreground) : undefined;
    if (!foreground && !style.fontStyle) return [];
    return [{
      token,
      ...(foreground ? { foreground } : {}),
      ...(style.fontStyle ? { fontStyle: style.fontStyle } : {})
    }];
  });
}
