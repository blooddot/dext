import type { Children, ComponentAttributes, UiRenderAdapter } from "../renderAdapter.js";

export function Disclosure<E>(
  { element }: UiRenderAdapter<E>, trigger: E, content: Children<E>, attributes: ComponentAttributes = {}
): E {
  return element("details", attributes, [trigger, ...content]);
}

export function DisclosureTrigger<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>, attributes: ComponentAttributes = {}
): E {
  return element("summary", attributes, children);
}
