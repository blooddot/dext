import type { ComponentAttributes } from "../../../shared/lib/ui/renderAdapter.js";
import { domUiAdapter } from "../../../platform/browser/domUiAdapter.js";
import { Field, Input, Textarea } from "../../../shared/lib/ui/input/formComponents.js";

export function interactionField(label: string, required: boolean, description?: string): HTMLFieldSetElement {
  return Field(domUiAdapter(document), `${label}${required ? " *" : ""}`, [], {
    description, attributes: { class: "interaction-field" }
  }) as HTMLFieldSetElement;
}

export function interactionTextInput(
  label: string, value: string, placeholder: string, attributes: ComponentAttributes = {}, multiline = false
): HTMLInputElement | HTMLTextAreaElement {
  const adapter = domUiAdapter(document);
  const properties = { autocomplete: "off", maxlength: "20000", "aria-label": label, placeholder, ...attributes };
  const control = (multiline ? Textarea(adapter, properties) : Input(adapter, properties)) as HTMLInputElement | HTMLTextAreaElement;
  control.value = value;
  return control;
}

export function interactionOptionDescription(description?: string): HTMLElement[] {
  const { element } = domUiAdapter(document);
  return description ? [element("small", {}, [description])] : [];
}
