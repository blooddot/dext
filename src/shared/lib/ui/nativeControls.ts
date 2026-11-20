import type { ComponentAttributes, UiRenderAdapter } from "./renderAdapter.js";

export function Button<E>(adapter: UiRenderAdapter<E>, attributes: ComponentAttributes, children: readonly (E | string)[] = []): E {
  return adapter.element("button", { type: "button", ...attributes }, children);
}

function choiceInput<E>(
  adapter: UiRenderAdapter<E>, type: "checkbox" | "radio", { class: className = false, ...attributes }: ComponentAttributes
): E {
  return adapter.element("input", { class: className, type, ...attributes }, []);
}

export function Checkbox<E>(adapter: UiRenderAdapter<E>, attributes: ComponentAttributes): E {
  return choiceInput(adapter, "checkbox", attributes);
}

export function Radio<E>(adapter: UiRenderAdapter<E>, attributes: ComponentAttributes): E {
  return choiceInput(adapter, "radio", attributes);
}

export function Label<E>(adapter: UiRenderAdapter<E>, attributes: ComponentAttributes, children: readonly (E | string)[]): E {
  return adapter.element("label", attributes, children);
}

export function Alert<E>(adapter: UiRenderAdapter<E>, text: string, attributes: ComponentAttributes = {}): E {
  return adapter.element("p", { role: "alert", ...attributes }, [text]);
}
