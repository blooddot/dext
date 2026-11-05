import { monaco } from "./monacoEnvironment.js";
import type { EditorTokenTheme } from "../shared/contracts/theme.js";
import { mixDefaultForeground, monacoColor, monacoThemeRules } from "./monacoThemeRules.js";

/** The Monaco theme the composer and the conversation both paint code with. */
export const DEXT_MONACO_THEME = "dext";

export function applyMonacoTheme(theme?: EditorTokenTheme): void {
  const css = getComputedStyle(document.body);
  const appearance = document.body.dataset.dextTheme;
  const contrast = document.body.className.includes("high-contrast");
  const workbenchLight = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
  // Paper and Dim are self-contained palettes, so Monaco cannot infer its base
  // from the workbench classes alone. High contrast still wins over both.
  const light = appearance === "paper" ? true : appearance === "dim" ? false : workbenchLight;
  const colors: Record<string, string> = {};
  for (const name of ["textLink.foreground", "textCodeBlock.background", "widget.border", "contrastBorder", "editorGutter.background", "editor.background", "editor.foreground", "editorCursor.foreground", "editorLineNumber.foreground", "editorLineNumber.activeForeground", "editor.selectionBackground", "editor.inactiveSelectionBackground", "editor.lineHighlightBackground", "editorWidget.background", "editorWidget.foreground", "editorWidget.border", "editorSuggestWidget.background", "editorSuggestWidget.foreground", "editorSuggestWidget.selectedBackground", "editorHoverWidget.background", "editorHoverWidget.foreground", "editorHoverWidget.border", "editorError.foreground", "editorWarning.foreground", "editorInfo.foreground", "focusBorder"]) {
    const value = css.getPropertyValue(`--vscode-${name.replaceAll(".", "-")}`).trim();
    const color = monacoColor(value);
    if (color) colors[name] = `#${color}`;
  }
  // Plain composer text follows the conversation's softened foreground; high
  // contrast keeps the theme's own full-strength text.
  const defaultText = contrast ? undefined : mixDefaultForeground(
    css.getPropertyValue("--vscode-foreground"), css.getPropertyValue("--vscode-editor-background"), 0.92);
  monaco.editor.defineTheme(DEXT_MONACO_THEME, {
    base: contrast ? light ? "hc-light" : "hc-black" : light ? "vs" : "vs-dark",
    inherit: true,
    rules: [...(defaultText ? [{ token: "", foreground: defaultText }] : []), ...monacoThemeRules(theme)],
    colors
  });
  monaco.editor.setTheme(DEXT_MONACO_THEME);
}
