import type { Children, ComponentAttributes, UiRenderAdapter } from "../renderAdapter.js";

export function Dialog<E>(
  { element }: UiRenderAdapter<E>,
  name: { label: string } | { labelledBy: string },
  children: Children<E>,
  attributes: ComponentAttributes = {}
): E {
  const title: ComponentAttributes = "label" in name ? { "aria-label": name.label } : { "aria-labelledby": name.labelledBy };
  return element("dialog", { ...attributes, ...title }, children);
}
