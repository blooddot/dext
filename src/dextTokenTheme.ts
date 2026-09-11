import { tags, tagHighlighter, type Tag } from "@lezer/highlight";
import type { EditorTokenTheme } from "./vscodeTheme.js";
import type { TurnMode } from "./turnPresentation.js";

export function shouldHighlightInput(source: string, mode?: TurnMode): boolean {
  if (mode) return mode === "code";
  // Legacy turns have no saved mode. Preserve their existing code detection.
  return /^(?:(?:await|const|let|var)\s+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s*(?:\(|=)/.test(source.trimStart());
}

/** One tag mapping for the editable input and both read-only input views. */
const tokens: Record<keyof EditorTokenTheme, { tags: readonly Tag[]; class: string; fallback: string }> = {
  keyword: { tags: [tags.keyword, tags.controlKeyword], class: "tok-keyword", fallback: "#c586c0" },
  string: { tags: [tags.string, tags.special(tags.string)], class: "tok-string", fallback: "#ce9178" },
  number: { tags: [tags.number], class: "tok-number", fallback: "#b5cea8" },
  boolean: { tags: [tags.bool, tags.null], class: "tok-bool", fallback: "#569cd6" },
  comment: { tags: [tags.comment, tags.docComment], class: "tok-comment", fallback: "var(--vscode-descriptionForeground)" },
  function: { tags: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "tok-function", fallback: "#dcdcaa" },
  property: { tags: [tags.propertyName, tags.attributeName], class: "tok-propertyName", fallback: "#9cdcfe" },
  variable: { tags: [tags.variableName, tags.definition(tags.variableName)], class: "tok-variableName", fallback: "var(--vscode-editor-foreground)" },
  type: { tags: [tags.typeName, tags.className], class: "tok-typeName", fallback: "#4ec9b0" },
  operator: { tags: [tags.operator, tags.operatorKeyword], class: "tok-operator", fallback: "var(--vscode-editor-foreground)" },
  punctuation: { tags: [tags.punctuation, tags.bracket], class: "tok-punctuation", fallback: "var(--vscode-editor-foreground)" }
};

export const dextClassHighlighter = tagHighlighter(Object.values(tokens).map((token) => ({ tag: token.tags, class: token.class })));

export function dextTokenRules(theme?: EditorTokenTheme): { tag: readonly Tag[]; color: string; class: string }[] {
  return (Object.entries(tokens) as [keyof EditorTokenTheme, typeof tokens.keyword][]).map(([name, token]) => ({
    tag: token.tags,
    // Missing theme entries inherit the editor foreground, as in CodeMirror.
    color: theme ? theme[name] ?? "inherit" : token.fallback,
    class: token.class
  }));
}

export function dextTokenStyles(theme?: EditorTokenTheme): string {
  return dextTokenRules(theme).map((rule) => `.${rule.class}{color:${rule.color}}`).join("");
}
