import { Button } from "../../../shared/lib/ui/nativeControls.js";
import { TraceIcon, TraceTitle } from "../../../shared/lib/ui/traceComponents.js";
import type { ComponentAttributes } from "../../../shared/lib/ui/renderAdapter.js";
import { domUiAdapter } from "../../../platform/browser/domUiAdapter.js";

export function composerMenuItem(
  attributes: ComponentAttributes, children: HTMLElement[], onClick: (event: MouseEvent) => void
): HTMLButtonElement {
  const button = Button(domUiAdapter(document), { class: "composer-menu-option", tabindex: "-1", ...attributes }, children) as HTMLButtonElement;
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
  return domUiAdapter(document).element("div", { class: "composer-menu-empty" }, [text]);
}

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>(":scope > button")].filter((button) => !button.disabled);
}

export function focusComposerMenuItem(menu: HTMLElement, index: number): void {
  const items = enabledItems(menu);
  if (!items.length) return;
  const target = items[Math.max(0, Math.min(index, items.length - 1))]!;
  items.forEach((item) => { item.tabIndex = item === target ? 0 : -1; });
  target.focus();
}

export function focusComposerMenuSelection(menu: HTMLElement, preferSelected: boolean): void {
  const selected = preferSelected ? enabledItems(menu).findIndex((button) => button.getAttribute("aria-checked") === "true") : 0;
  focusComposerMenuItem(menu, selected);
}

export function bindComposerMenuKeys(menu: HTMLElement, actions: {
  close(): void;
  openSubmenu?(item: HTMLButtonElement): void;
  returnToParent?(): void;
}): void {
  menu.addEventListener("keydown", (event) => {
    const items = enabledItems(menu);
    if (!items.length) return;
    const current = items.indexOf(menu.ownerDocument.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      actions.close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : current < 0 ? 0 : (current + direction + items.length) % items.length;
      focusComposerMenuItem(menu, next);
      return;
    }
    if (event.key === "ArrowRight" && current >= 0 && actions.openSubmenu) {
      event.preventDefault();
      actions.openSubmenu(items[current]!);
    } else if (event.key === "ArrowLeft" && actions.returnToParent) {
      event.preventDefault();
      actions.returnToParent();
    }
  });
}
