import { monaco } from "./monacoEnvironment.js";
import type { EditorTokenTheme } from "../vscodeTheme.js";
import { monacoColor, monacoThemeRules } from "./monacoThemeRules.js";

/** The Monaco theme the composer and the conversation both paint code with. */
export const DEXT_MONACO_THEME = "dext";

export function applyMonacoTheme(theme?: EditorTokenTheme): void {
  const css = getComputedStyle(document.body);
  const light = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
  const contrast = document.body.className.includes("high-contrast");
  const colors: Record<string, string> = {};
  for (const name of ["textLink.foreground", "textCodeBlock.background", "widget.border", "contrastBorder", "editorGutter.background", "editor.background", "editor.foreground", "editorCursor.foreground", "editorLineNumber.foreground", "editorLineNumber.activeForeground", "editor.selectionBackground", "editor.inactiveSelectionBackground", "editor.lineHighlightBackground", "editorWidget.background", "editorWidget.foreground", "editorWidget.border", "editorSuggestWidget.background", "editorSuggestWidget.foreground", "editorSuggestWidget.selectedBackground", "editorHoverWidget.background", "editorHoverWidget.foreground", "editorHoverWidget.border", "editorError.foreground", "editorWarning.foreground", "editorInfo.foreground", "focusBorder"]) {
    const value = css.getPropertyValue(`--vscode-${name.replaceAll(".", "-")}`).trim();
    const color = monacoColor(value);
    if (color) colors[name] = `#${color}`;
  }
  monaco.editor.defineTheme(DEXT_MONACO_THEME, {
    base: contrast ? light ? "hc-light" : "hc-black" : light ? "vs" : "vs-dark",
    inherit: true,
    rules: monacoThemeRules(theme),
    colors
  });
  monaco.editor.setTheme(DEXT_MONACO_THEME);
}
