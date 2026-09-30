import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "jsonc-parser/lib/esm/main.js";
import * as vscode from "vscode";

export type EditorTokenName =
  | "keyword" | "string" | "number" | "boolean" | "comment" | "function" | "property"
  | "variable" | "identifier" | "type" | "operator" | "punctuation" | "delimiter" | "regexp";

/** How the active theme paints one kind of token. */
export interface EditorTokenStyle {
  foreground?: string;
  /** `italic`, `bold`, `underline`, or a combination, exactly as the theme wrote it. */
  fontStyle?: string;
}

export type EditorTokenTheme = Partial<Record<EditorTokenName, EditorTokenStyle>>;

interface TextMateRule {
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

interface ThemeFile {
  include?: string;
  tokenColors?: TextMateRule[];
}

const SCOPES: Readonly<Record<EditorTokenName, readonly string[]>> = {
  keyword: ["keyword.control", "keyword", "storage.modifier"],
  string: ["string.quoted", "string"],
  number: ["constant.numeric"],
  boolean: ["constant.language.boolean", "constant.language.none"],
  comment: ["comment.line", "comment.block", "comment"],
  function: ["entity.name.function", "support.function", "variable.function"],
  property: ["variable.other.property", "support.type.property-name", "meta.object-literal.key"],
  variable: ["variable.other.readwrite", "variable.other", "variable"],
  // Monaco's TypeScript tokenizer has one `identifier` token for every name — a function
  // call and a local variable look the same to it — so the theme's plain-identifier scope
  // is what paints it; leaving it unmapped is what kept the composer's names on Monaco's
  // own default color instead of the user's.
  identifier: ["variable.other.readwrite", "variable.other", "variable", "entity.name.function", "support.function"],
  type: ["entity.name.type", "entity.name.class", "support.type", "support.class", "storage.type"],
  operator: ["keyword.operator"],
  punctuation: ["punctuation.definition", "punctuation.section", "punctuation.separator", "punctuation.terminator", "meta.brace", "punctuation"],
  // Braces, parentheses and the semicolon: the grammar emits `delimiter.bracket`,
  // `delimiter.parenthesis` and `delimiter`, and a theme that colors punctuation has to
  // reach all three.
  delimiter: ["meta.brace", "punctuation.definition", "punctuation.section", "punctuation.separator", "punctuation.terminator", "punctuation"],
  regexp: ["string.regexp", "string"]
};

function readTheme(filePath: string, seen = new Set<string>()): TextMateRule[] {
  const absolute = resolve(filePath);
  if (seen.has(absolute)) return [];
  seen.add(absolute);
  const theme = parse(readFileSync(absolute, "utf8")) as ThemeFile | undefined;
  const inherited = theme?.include
    ? readTheme(resolve(dirname(absolute), theme.include), seen)
    : [];
  return [...inherited, ...(Array.isArray(theme?.tokenColors) ? theme.tokenColors : [])];
}

function scopes(rule: TextMateRule): string[] {
  const values = Array.isArray(rule.scope) ? rule.scope : [rule.scope ?? ""];
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function matchSpecificity(selector: string, candidate: string): number {
  const scope = selector.split(/\s+/).at(-1) ?? selector;
  if (candidate === scope) return scope.split(".").length * 100 + scope.length;
  if (candidate.startsWith(`${scope}.`)) return scope.split(".").length * 100 + scope.length;
  return -1;
}

/** TextMate resolves a token by walking its scopes in order: the most specific rule wins,
 * a later rule breaks a tie, and `foreground` and `fontStyle` are chosen independently
 * (a rule that only says `italic` does not clear the color another rule gave). */
function applyRules(target: EditorTokenTheme, rules: readonly TextMateRule[]): void {
  type Winner = { specificity: number; index: number; value: string };
  for (const [name, candidates] of Object.entries(SCOPES) as [EditorTokenName, readonly string[]][]) {
    let foreground: Winner | undefined;
    let fontStyle: Winner | undefined;
    const wins = (current: Winner | undefined, specificity: number, index: number): boolean =>
      !current || specificity > current.specificity || (specificity === current.specificity && index >= current.index);
    for (const [index, rule] of rules.entries()) {
      const settings = rule.settings;
      if (!settings?.foreground && !settings?.fontStyle) continue;
      const specificity = Math.max(
        -1,
        ...scopes(rule).flatMap((selector) =>
          candidates.map((candidate) => matchSpecificity(selector, candidate))
        )
      );
      if (specificity < 0) continue;
      if (settings.foreground && wins(foreground, specificity, index)) foreground = { specificity, index, value: settings.foreground };
      if (settings.fontStyle && wins(fontStyle, specificity, index)) fontStyle = { specificity, index, value: settings.fontStyle };
    }
    if (foreground || fontStyle) {
      target[name] = {
        ...(foreground ? { foreground: foreground.value } : {}),
        ...(fontStyle ? { fontStyle: fontStyle.value } : {})
      };
    }
  }
}

function customizationRules(value: unknown): TextMateRule[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const shorthand: [EditorTokenName, string][] = [
    ["comment", "comments"], ["string", "strings"], ["number", "numbers"],
    ["keyword", "keywords"], ["type", "types"], ["function", "functions"], ["variable", "variables"]
  ];
  const result = shorthand.flatMap(([token, key]) => typeof object[key] === "string"
    ? SCOPES[token].map((scope) => ({ scope, settings: { foreground: object[key] as string } }))
    : []);
  return [...result, ...(Array.isArray(object.textMateRules) ? object.textMateRules as TextMateRule[] : [])];
}

function configuredThemeName(): string {
  const configuration = vscode.workspace.getConfiguration();
  const active = vscode.window.activeColorTheme.kind;
  if (configuration.get<boolean>("window.autoDetectColorScheme")) {
    if (active === vscode.ColorThemeKind.Dark) {
      return configuration.get<string>("workbench.preferredDarkColorTheme", "Default Dark Modern");
    }
    if (active === vscode.ColorThemeKind.Light) {
      return configuration.get<string>("workbench.preferredLightColorTheme", "Default Light Modern");
    }
  }
  if (configuration.get<boolean>("window.autoDetectHighContrast")) {
    if (active === vscode.ColorThemeKind.HighContrast) {
      return configuration.get<string>("workbench.preferredHighContrastColorTheme", "Default High Contrast");
    }
    if (active === vscode.ColorThemeKind.HighContrastLight) {
      return configuration.get<string>("workbench.preferredHighContrastLightColorTheme", "Default High Contrast Light");
    }
  }
  return configuration.get<string>("workbench.colorTheme", "Default Dark Modern");
}

export function loadEditorTokenTheme(): EditorTokenTheme | undefined {
  try {
    const name = configuredThemeName();
    const contribution = vscode.extensions.all.flatMap((extension) => {
      const packageJson = extension.packageJSON as { contributes?: { themes?: unknown } };
      const themes = packageJson.contributes?.themes;
      return Array.isArray(themes)
        ? themes.map((theme: { id?: string; label?: string; path?: string }) => ({ extension, theme }))
        : [];
    }).find(({ theme }) => (theme.id === name || theme.label === name) && typeof theme.path === "string");
    if (!contribution?.theme.path) return undefined;
    const result: EditorTokenTheme = {};
    applyRules(result, readTheme(resolve(contribution.extension.extensionPath, contribution.theme.path)));
    const customizations = vscode.workspace.getConfiguration("editor").get<unknown>("tokenColorCustomizations");
    applyRules(result, customizationRules(customizations));
    if (customizations && typeof customizations === "object") {
      applyRules(result, customizationRules((customizations as Record<string, unknown>)[`[${name}]`]));
    }
    return Object.keys(result).length ? result : undefined;
  } catch (error) {
    console.warn("Dext could not load the active TextMate theme.", error);
    return undefined;
  }
}
