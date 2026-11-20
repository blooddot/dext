import type { ComponentAttributes } from "../../../shared/lib/ui/renderAdapter.js";
import { domUiAdapter } from "../../../platform/browser/domUiAdapter.js";

export function interactionField(label: string, required: boolean, description?: string): HTMLFieldSetElement {
  const { element } = domUiAdapter(document);
  const legend = element("legend", {}, [`${label}${required ? " *" : ""}`]);
  const detail = description ? [element("p", {}, [description])] : [];
  return element("fieldset", { class: "interaction-field" }, [legend, ...detail]) as HTMLFieldSetElement;
}

export function interactionTextInput(
  label: string, value: string, placeholder: string, attributes: ComponentAttributes = {}, multiline = false
): HTMLInputElement | HTMLTextAreaElement {
  const { element } = domUiAdapter(document);
  const control = element(multiline ? "textarea" : "input", {
    autocomplete: "off", maxlength: "20000", "aria-label": label, placeholder, ...attributes
  }, []) as HTMLInputElement | HTMLTextAreaElement;
  control.value = value;
  return control;
}

export function interactionOptionDescription(description?: string): HTMLElement[] {
  const { element } = domUiAdapter(document);
  return description ? [element("small", {}, [description])] : [];
}
