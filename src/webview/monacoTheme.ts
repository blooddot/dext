import { monaco } from "./monacoEnvironment.js";
import type { EditorTokenTheme } from "../vscodeTheme.js";

function monacoColor(value: string): string | undefined {
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) return [...hex].map((part) => part + part).join("");
  if (/^[0-9a-f]{4}$/i.test(hex)) return [...hex].map((part) => part + part).join("");
  return /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex) ? hex : undefined;
}

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
  monaco.editor.defineTheme("dext", { base: contrast ? light ? "hc-light" : "hc-black" : light ? "vs" : "vs-dark", inherit: true,
    rules: (Object.entries(theme ?? {}) as Array<[string, string]>).flatMap(([token, foreground]) => {
      const color = monacoColor(foreground);
      return color ? [{ token, foreground: color }] : [];
    }), colors });
  monaco.editor.setTheme("dext");
}
