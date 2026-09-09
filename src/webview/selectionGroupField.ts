import type { UiFieldAnswer, UiSelectionField } from "../core/uiForm.js";

export interface FieldControl {
  element: HTMLElement;
  read(): UiFieldAnswer;
  clearSecret(): void;
}
let groupId = 0;
export function selectionGroupField(field: UiSelectionField, draft: UiFieldAnswer | undefined, change: () => void): FieldControl {
  const element = document.createElement("div");
  element.className = "interaction-options";
  const name = `interaction-group-${++groupId}`;
  const selected = draft && draft.type !== "input" ? draft.selected : field.default ?? [];
  const inputs: HTMLInputElement[] = [];
  const custom = document.createElement("input");
  custom.type = field.secret ? "password" : "text";
  custom.autocomplete = "off"; custom.maxLength = 20000;
  custom.value = draft && "custom" in draft ? draft.custom ?? "" : "";
  custom.placeholder = field.custom_placeholder || "Your own answer";
  custom.setAttribute("aria-label", `${field.label} — Your answer`);
  for (const option of field.options) {
    const label = document.createElement("label"); label.className = "interaction-option";
    const input = document.createElement("input"); input.type = field.type === "checkbox" ? "checkbox" : "radio";
    input.name = name; input.value = option.value; input.checked = selected.includes(option.value);
    const copy = document.createElement("span"); copy.textContent = option.label;
    if (option.description) { const detail = document.createElement("small"); detail.textContent = option.description; copy.append(detail); }
    input.addEventListener("change", () => { if (field.type === "radio") custom.value = ""; change(); });
    inputs.push(input); label.append(input, copy); element.append(label);
  }
  if (field.allow_custom) {
    custom.addEventListener("input", () => { if (field.type === "radio") for (const input of inputs) input.checked = false; change(); });
    element.append(custom);
  }
  return { element, read: () => ({ type: field.type === "checkbox" ? "checkbox" : "radio",
    selected: inputs.filter((input) => input.checked).map((input) => input.value),
    ...(field.allow_custom && custom.value.trim() ? { custom: custom.value } : {}) }),
    clearSecret: () => { if (field.secret) { custom.value = ""; for (const input of inputs) input.checked = false; } } };
}
