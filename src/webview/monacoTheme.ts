import { monaco } from "./monacoEnvironment.js";
import type { EditorTokenTheme } from "../shared/contracts/theme.js";
import { MONACO_COLOR_IDS, mixDefaultForeground, monacoColor, monacoThemeRules, paletteTokenTheme } from "./monacoThemeRules.js";

/** The Monaco theme the composer and the conversation both paint code with. */
export const DEXT_MONACO_THEME = "dext";

/** The Monaco token rules of the last call: a surface that only wants the colors
 * refreshed (a form field) must not drop them for every other surface. */
let appliedTheme: EditorTokenTheme | undefined;

export function applyMonacoTheme(theme: EditorTokenTheme | undefined = appliedTheme): void {
  appliedTheme = theme;
  const css = getComputedStyle(document.body);
  const appearance = document.body.dataset.dextTheme;
  const contrast = document.body.className.includes("high-contrast");
  const workbenchLight = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
  // Paper and Dim are self-contained palettes, so Monaco cannot infer its base
  // from the workbench classes alone. High contrast still wins over both.
  const light = appearance === "paper" ? true : appearance === "dim" ? false : workbenchLight;
  // Paper and Dim paint their own syntax palette; Auto keeps the workbench theme.
  const palette = appearance === "paper" || appearance === "dim";
  const colors: Record<string, string> = {};
  for (const name of MONACO_COLOR_IDS) {
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
    rules: [...(defaultText ? [{ token: "", foreground: defaultText }] : []), ...monacoThemeRules(palette ? paletteTokenTheme(css, theme) : theme)],
    colors
  });
  monaco.editor.setTheme(DEXT_MONACO_THEME);
}
