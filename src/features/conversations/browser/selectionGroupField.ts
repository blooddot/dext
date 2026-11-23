import type { UiFieldAnswer, UiSelectionField } from "../../../shared/contracts/uiForm.js";
import { Button, Checkbox, Label, Radio } from "../../../shared/lib/ui/input/nativeControls.js";
import { interactionOptionDescription, interactionTextInput } from "./interactionControls.js";
import { domUiAdapter } from "../../../platform/browser/domUiAdapter.js";

export interface FieldControl {
  element: HTMLElement;
  read(): UiFieldAnswer;
  clearSecret(): void;
  /** Released when the form is terminal and its answers are already read. */
  disable?(): void;
}
let groupId = 0;
export function selectionGroupField(field: UiSelectionField, draft: UiFieldAnswer | undefined, change: () => void): FieldControl {
  const adapter = domUiAdapter(document);
  const element = adapter.element("div", { class: "interaction-options" }, []);
  const name = `interaction-group-${++groupId}`;
  const selected = draft && draft.type !== "input" ? draft.selected : field.default ?? [];
  const inputs: HTMLInputElement[] = [];
  const custom = interactionTextInput(`${field.label} — Your answer`, draft && "custom" in draft ? draft.custom ?? "" : "",
    field.custom_placeholder || "Your own answer", { type: field.secret ? "password" : "text" });
  for (const option of field.options) {
    const attributes = { name, value: option.value };
    const input = (field.type === "checkbox" ? Checkbox(adapter, attributes) : Radio(adapter, attributes)) as HTMLInputElement;
    input.checked = selected.includes(option.value);
    const copy = adapter.element("span", {}, [option.label, ...interactionOptionDescription(option.description)]);
    input.addEventListener("change", () => { if (field.type === "radio") custom.value = ""; change(); });
    inputs.push(input); element.append(Label(adapter, { class: "interaction-option" }, [input, copy]));
  }
  if (field.allow_custom) {
    custom.addEventListener("input", () => { if (field.type === "radio") for (const input of inputs) input.checked = false; change(); });
    element.append(custom);
  }
  if (field.type === "radio" && !field.required) {
    const clear = Button(adapter, { "aria-label": `Clear ${field.label}` }, ["Clear"]);
    clear.addEventListener("click", () => { for (const input of inputs) input.checked = false; custom.value = ""; change(); });
    element.append(clear);
  }
  return { element, read: () => ({ type: field.type === "checkbox" ? "checkbox" : "radio",
    selected: inputs.filter((input) => input.checked).map((input) => input.value),
    ...(field.allow_custom && custom.value.trim() ? { custom: custom.value } : {}) }),
    clearSecret: () => { if (field.secret) { custom.value = ""; for (const input of inputs) input.checked = false; } } };
}
