import type { Children, ComponentAttributes, UiRenderAdapter } from "../renderAdapter.js";
export { Disclosure as TraceCollapsible, DisclosureTrigger as TraceCollapsibleTrigger } from "./disclosure.js";

export function Trace<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>, attributes: ComponentAttributes = {}, tag = "ul"
): E {
  return element(tag, tag === "ul" || tag === "ol" ? attributes : { role: "list", ...attributes }, children);
}

export function TraceCollapsibleContent<E>(
  { element }: UiRenderAdapter<E>, children: readonly E[], attributes: ComponentAttributes = {}, tag?: string
): readonly E[] {
  return tag ? [element(tag, attributes, children)] : children;
}

export function TraceLine<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>, attributes: ComponentAttributes = {}, tag = "li"
): E {
  return element(tag, tag === "li" || tag === "summary" ? attributes : { role: "listitem", ...attributes }, children);
}

export function TraceIcon<E>({ element }: UiRenderAdapter<E>, icon: string, attributes: ComponentAttributes = {}): E {
  return element("i", { class: `codicon codicon-${icon}`, ...attributes, "aria-hidden": "true" }, []);
}

export function TraceChevron<E>(adapter: UiRenderAdapter<E>): E {
  return TraceIcon(adapter, "chevron-right", { class: "disclosure-chevron codicon codicon-chevron-right" });
}

export function TraceTitle<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>, attributes: ComponentAttributes = {}, tag = "span"
): E {
  return element(tag, attributes, children);
}

export function TraceDescription<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>, attributes: ComponentAttributes = {}, tag = "span"
): E {
  return element(tag, attributes, children);
}
