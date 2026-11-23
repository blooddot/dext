import { UI_VIEW_LAYOUT_DEFAULTS, type UiGap } from "../../../contracts/uiView.js";
import type { Children, ComponentAttributes, UiRenderAdapter } from "../renderAdapter.js";

export function Stack<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>,
  { gap = UI_VIEW_LAYOUT_DEFAULTS.Stack.gap, attributes = {}, tag = "div" }: {
    gap?: UiGap | undefined; attributes?: ComponentAttributes; tag?: "div" | "section";
  } = {}
): E {
  return element(tag, { "data-ui": "stack", "data-gap": gap, ...attributes }, children);
}

export function Inline<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>,
  { gap = UI_VIEW_LAYOUT_DEFAULTS.Inline.gap, wrap = UI_VIEW_LAYOUT_DEFAULTS.Inline.wrap, attributes = {} }: {
    gap?: UiGap | undefined; wrap?: boolean | undefined; attributes?: ComponentAttributes;
  } = {}
): E {
  return element("div", { "data-ui": "inline", "data-gap": gap, "data-wrap": String(wrap), ...attributes }, children);
}

export function Section<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>,
  { title, description, level = 3, attributes = {}, headingAttributes = {} }: {
    title: string; description?: string | undefined; level?: 2 | 3 | 4 | 5 | 6;
    attributes?: ComponentAttributes; headingAttributes?: ComponentAttributes;
  }
): E {
  const heading = element(`h${level}`, headingAttributes, [title]);
  const introductory = description ? [element("p", { "data-ui": "section-description" }, [description])] : [];
  return element("section", { "data-ui": "section", ...attributes }, [heading, ...introductory, ...children]);
}

export function Toolbar<E>(
  { element }: UiRenderAdapter<E>, label: string, attributes: ComponentAttributes, children: Children<E>, tag: "div" | "header" = "div"
): E {
  return element(tag, { role: "group", "aria-label": label, ...attributes }, children);
}
