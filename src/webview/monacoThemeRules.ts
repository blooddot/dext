import type { EditorTokenName, EditorTokenTheme } from "../vscodeTheme.js";

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
  ["annotation", "function"]
];

/** `#rgb`, `#rrggbb` and `#rrggbbaa` are what themes write; Monaco wants `RRGGBB`. */
export function monacoColor(value: string): string | undefined {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return [...hex].map((part) => part + part).join("");
  if (/^[0-9a-f]{4}$/i.test(hex)) return [...hex].map((part) => part + part).join("");
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex) ? hex : undefined;
}

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
