import type { ComponentAttributes, UiRenderAdapter } from "../renderAdapter.js";

export function Badge<E>({ element }: UiRenderAdapter<E>, text: string, attributes: ComponentAttributes = {}): E {
  return element("span", attributes, [text]);
}

export function Spinner<E>(
  { element }: UiRenderAdapter<E>, attributes: ComponentAttributes = {}, label?: string, tag = "i"
): E {
  return element(tag, {
    class: "codicon codicon-loading codicon-modifier-spin",
    ...(label === undefined ? { "aria-hidden": "true" } : { role: "status", "aria-label": label }),
    ...attributes
  }, []);
}

export function Alert<E>(adapter: UiRenderAdapter<E>, content: string | readonly (E | string)[], attributes: ComponentAttributes = {}, tag = "p"): E {
  return adapter.element(tag, { role: "alert", ...attributes }, typeof content === "string" ? [content] : content);
}

export function Empty<E>({ element }: UiRenderAdapter<E>, text: string, attributes: ComponentAttributes = {}, tag = "p"): E {
  return element(tag, { "data-ui": "empty", ...attributes }, [text]);
}
