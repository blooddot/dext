import { MenuItem } from "../../../shared/lib/ui/navigation/navigationComponents.js";
import { Empty } from "../../../shared/lib/ui/feedback/feedbackComponents.js";
import { TraceIcon, TraceTitle } from "../../../shared/lib/ui/content/traceComponents.js";
import type { ComponentAttributes } from "../../../shared/lib/ui/renderAdapter.js";
import { domUiAdapter } from "../../../platform/browser/domUiAdapter.js";

export function composerMenuItem(
  attributes: ComponentAttributes, children: HTMLElement[], onClick: (event: MouseEvent) => void
): HTMLButtonElement {
  const button = MenuItem(domUiAdapter(document), { class: "composer-menu-option", ...attributes }, children) as HTMLButtonElement;
  button.addEventListener("click", onClick);
  return button;
}

export function composerMenuChoice(
  label: string, checked: boolean | "mixed", role: "menuitemradio" | "menuitemcheckbox",
  attributes: ComponentAttributes, onClick: (event: MouseEvent) => void,
  options: { leading?: string; checkFirst?: boolean; hint?: string } = {}
): HTMLButtonElement {
  const adapter = domUiAdapter(document);
  const glyph = TraceIcon(adapter, checked === "mixed" ? "circle-filled" : checked ? "check" : "blank");
  const hint = options.hint ? [adapter.element("small", { class: "composer-skill-commands" }, [options.hint])] : [];
  const title = TraceTitle(adapter, [label, ...hint]);
  const leading = options.leading ? [TraceIcon(adapter, options.leading, { class: `codicon ${options.leading}` })] : [];
  return composerMenuItem({ role, "aria-checked": String(checked), ...attributes },
    options.checkFirst ? [glyph, title] : [...leading, title, glyph], onClick);
}

export function composerMenuCategory(title: string, value: string, open: (event: MouseEvent) => void): HTMLButtonElement {
  const adapter = domUiAdapter(document);
  return composerMenuItem({ class: "composer-menu-option composer-menu-category" }, [
    TraceTitle(adapter, [title]), TraceTitle(adapter, [value], { class: "composer-menu-category-value" }), TraceIcon(adapter, "chevron-right")
  ], open);
}

export function composerMenuEmpty(text: string): HTMLElement {
  return Empty(domUiAdapter(document), text, { class: "composer-menu-empty" }, "div");
}
