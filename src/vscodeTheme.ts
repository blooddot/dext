import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "jsonc-parser/lib/esm/main.js";
import * as vscode from "vscode";

export interface EditorTokenTheme {
  keyword?: string;
  string?: string;
  number?: string;
  boolean?: string;
  comment?: string;
  function?: string;
  property?: string;
  variable?: string;
  type?: string;
  operator?: string;
  punctuation?: string;
}

interface TextMateRule {
  scope?: string | string[];
  settings?: { foreground?: string };
}

interface ThemeFile {
  include?: string;
  tokenColors?: TextMateRule[];
}

const SCOPES: Readonly<Record<keyof EditorTokenTheme, readonly string[]>> = {
  keyword: ["keyword.control", "keyword", "storage.modifier"],
  string: ["string.quoted", "string"],
  number: ["constant.numeric"],
  boolean: ["constant.language.boolean", "constant.language.none"],
  comment: ["comment.line", "comment.block", "comment"],
  function: ["entity.name.function", "support.function", "variable.function"],
  property: ["variable.other.property", "support.type.property-name", "meta.object-literal.key"],
  variable: ["variable.other", "variable"],
  type: ["entity.name.type", "entity.name.class", "support.type", "storage.type"],
  operator: ["keyword.operator"],
  punctuation: ["punctuation.definition", "punctuation.section", "punctuation.separator", "punctuation"]
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

function applyRules(target: EditorTokenTheme, rules: readonly TextMateRule[]): void {
  for (const [name, candidates] of Object.entries(SCOPES) as [keyof EditorTokenTheme, readonly string[]][]) {
    let best = { specificity: -1, index: -1, foreground: undefined as string | undefined };
    for (const [index, rule] of rules.entries()) {
      const foreground = rule.settings?.foreground;
      if (!foreground) continue;
      const specificity = Math.max(
        -1,
        ...scopes(rule).flatMap((selector) =>
          candidates.map((candidate) => matchSpecificity(selector, candidate))
        )
      );
      if (specificity < 0) continue;
      if (specificity > best.specificity || (specificity === best.specificity && index > best.index)) {
        best = { specificity, index, foreground };
      }
    }
    if (best.foreground) target[name] = best.foreground;
  }
}

function customizationRules(value: unknown): TextMateRule[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const shorthand: [keyof EditorTokenTheme, string][] = [
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
