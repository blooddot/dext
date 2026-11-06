import { isDextAppearance, type DextAppearance } from "../../shared/contracts/appearance.js";

/** The appearance attribute the host writes onto `<body>` before first paint. */
export function currentDextAppearance(): DextAppearance {
  const value = document.body.dataset.dextTheme;
  return isDextAppearance(value) ? value : "auto";
}

export function isDextHighContrast(): boolean {
  return document.body.classList.contains("vscode-high-contrast")
    || document.body.classList.contains("vscode-high-contrast-light");
}

/**
 * Whether the page is currently painted by a light palette. Monaco and Mermaid
 * cannot read CSS variables for their own theme choice, so
 * they ask this instead of inspecting the workbench classes alone. Paper is light
 * and Dim is dark regardless of the host theme; Auto defers to VS Code, including
 * its high-contrast variants.
 */
export function isDextLightSurface(): boolean {
  const appearance = currentDextAppearance();
  if (appearance === "paper") return true;
  if (appearance === "dim") return false;
  return document.body.classList.contains("vscode-light")
    || document.body.classList.contains("vscode-high-contrast-light");
}
