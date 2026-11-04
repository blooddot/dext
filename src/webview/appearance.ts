import { isDextAppearance, type DextAppearance } from "../shared/contracts/appearance.js";

/**
 * The Dext theme is chosen from the sidebar's view-title action and persisted by
 * the extension host. Every Dext document (sidebar, History and each editor tab)
 * only mirrors that decision onto <body>, where the palette CSS and Monaco read
 * it. No page draws its own theme control.
 */

const highContrast = (): boolean => document.body.classList.contains("vscode-high-contrast")
  || document.body.classList.contains("vscode-high-contrast-light");

const initialTheme = document.body.dataset.dextTheme;
let requested: DextAppearance = isDextAppearance(initialTheme) ? initialTheme : "auto";
let lastEffective: DextAppearance | undefined;

function update(): void {
  const effective: DextAppearance = highContrast() ? "auto" : requested;
  document.body.dataset.dextTheme = effective;

  if (effective === lastEffective) return;
  lastEffective = effective;
  document.dispatchEvent(new CustomEvent("dext-appearance-change", { detail: { theme: effective } }));
}

update();

// VS Code adds and removes its theme classes on <body> after the document has
// loaded. High contrast must win over Paper/Dim immediately, and leaving high
// contrast must restore the persisted choice.
new MutationObserver(update).observe(document.body, { attributes: true, attributeFilter: ["class"] });

window.addEventListener("message", (event) => {
  const message = event.data as { type?: unknown; theme?: unknown };
  if (message?.type !== "dextAppearance" || !isDextAppearance(message.theme)) return;
  requested = message.theme;
  update();
});
