import type { UiFieldAnswer, UiSelectionField } from "../core/uiForm.js";
import type { FieldControl } from "./selectionGroupField.js";

let popupId = 0;
/** A top-layer popover keeps dropdowns inside small dialogs from being clipped. */
export function selectField(field: UiSelectionField, draft: UiFieldAnswer | undefined, change: () => void): FieldControl {
  const element = document.createElement("div"); element.className = "interaction-select";
  const selected = new Set(draft && draft.type !== "input" ? draft.selected : field.default ?? []);
  const trigger = document.createElement("button"); trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", field.label);
  const popup = document.createElement("div"); popup.className = "interaction-select-popup";
  popup.id = `interaction-list-${++popupId}`; popup.popover = "manual";
  popup.setAttribute("role", "listbox"); popup.setAttribute("aria-label", field.label);
  if (field.multiple) popup.setAttribute("aria-multiselectable", "true");
  trigger.setAttribute("aria-controls", popup.id);
  const options: HTMLButtonElement[] = [];
  let opened = false;
  const close = (focus = true): void => {
    if (!opened) return; opened = false;
    popup.hidePopover(); trigger.setAttribute("aria-expanded", "false");
    if (focus && trigger.isConnected) trigger.focus();
  };
  const refresh = (): void => {
    trigger.textContent = field.options.filter((option) => selected.has(option.value)).map((option) => option.label).join(", ") || field.placeholder || "Select…";
    options.forEach((option) => option.setAttribute("aria-selected", String(selected.has(option.value))));
  };
  const open = (): void => {
    if (opened) return; opened = true;
    const rect = trigger.getBoundingClientRect();
    popup.style.width = `${Math.min(rect.width, window.innerWidth - 16)}px`;
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    popup.style.maxHeight = `${Math.max(50, Math.min(280, Math.max(below, above)))}px`;
    popup.style.top = below >= Math.min(280, above) ? `${rect.bottom}px` : "auto";
    popup.style.bottom = below >= Math.min(280, above) ? "auto" : `${window.innerHeight - rect.top}px`;
    popup.showPopover(); trigger.setAttribute("aria-expanded", "true");
    (options.find((option) => selected.has(option.value)) ?? options[0])?.focus();
  };
  for (const option of field.options) {
    const item = document.createElement("button"); item.type = "button"; item.value = option.value;
    item.setAttribute("role", "option"); item.tabIndex = -1; item.textContent = option.label;
    if (option.description) { const detail = document.createElement("small"); detail.textContent = option.description; item.append(detail); }
    item.addEventListener("click", () => {
      if (!field.multiple) selected.clear();
      if (field.multiple && selected.has(option.value)) selected.delete(option.value); else selected.add(option.value);
      refresh(); change(); if (!field.multiple) close();
    });
    options.push(item); popup.append(item);
  }
  popup.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === "Tab") close(false);
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % options.length : event.key === "ArrowUp" ? (index - 1 + options.length) % options.length
      : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); options[next]?.focus(); }
  });
  popup.addEventListener("focusout", () => { queueMicrotask(() => { if (!popup.contains(document.activeElement)) close(false); }); });
  trigger.addEventListener("click", () => opened ? close() : open());
  trigger.addEventListener("keydown", (event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); } });
  const clear = document.createElement("button"); clear.type = "button"; clear.textContent = "Clear";
  clear.setAttribute("aria-label", `Clear ${field.label}`);
  clear.addEventListener("click", () => { selected.clear(); refresh(); change(); trigger.focus(); });
  element.append(trigger, clear, popup); refresh();
  return { element, read: () => ({ type: "select", selected: [...selected] }), clearSecret: () => close(false) };
}
