import type { Children, ComponentAttributes, UiRenderAdapter } from "../renderAdapter.js";

export function Form<E>(
  { element }: UiRenderAdapter<E>, title: string, children: Children<E>, attributes: ComponentAttributes = {}
): E {
  return element("form", { "aria-label": title, ...attributes }, children);
}

export function Field<E>(
  { element }: UiRenderAdapter<E>, label: string, children: Children<E>,
  { description, attributes = {} }: { description?: string | undefined; attributes?: ComponentAttributes } = {}
): E {
  const legend = element("legend", {}, [label]);
  const detail = description ? [element("p", {}, [description])] : [];
  return element("fieldset", attributes, [legend, ...detail, ...children]);
}

export function Input<E>({ element }: UiRenderAdapter<E>, attributes: ComponentAttributes): E {
  return element("input", { type: "text", ...attributes }, []);
}

export function Textarea<E>({ element }: UiRenderAdapter<E>, attributes: ComponentAttributes, value = ""): E {
  return element("textarea", attributes, value ? [value] : []);
}

export function NativeSelect<E>({ element }: UiRenderAdapter<E>, attributes: ComponentAttributes, options: Children<E>): E {
  return element("select", attributes, options);
}
