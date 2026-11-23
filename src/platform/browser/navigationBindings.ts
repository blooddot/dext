export function setTabSelected(tab: HTMLElement, selected: boolean, selectedClass = "active"): void {
  tab.classList.toggle(selectedClass, selected);
  tab.setAttribute("aria-selected", String(selected));
}

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>(":scope > button")].filter((button) => !button.disabled);
}

export function focusMenuItem(menu: HTMLElement, index: number): void {
  const items = enabledItems(menu);
  if (!items.length) return;
  const target = items[Math.max(0, Math.min(index, items.length - 1))]!;
  items.forEach((item) => { item.tabIndex = item === target ? 0 : -1; });
  target.focus();
}

export function focusMenuSelection(menu: HTMLElement, preferSelected: boolean): void {
  const selected = preferSelected ? enabledItems(menu).findIndex((button) => button.getAttribute("aria-checked") === "true") : 0;
  focusMenuItem(menu, selected);
}

export function bindMenuKeys(menu: HTMLElement, actions: {
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
      focusMenuItem(menu, next);
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
