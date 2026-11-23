import { Button } from "../input/nativeControls.js";
import type { Children, ComponentAttributes, UiRenderAdapter } from "../renderAdapter.js";

export function Navigation<E>(
  { element }: UiRenderAdapter<E>, label: string, attributes: ComponentAttributes, children: Children<E>
): E {
  return element("nav", { "aria-label": label, ...attributes }, children);
}

export function TabList<E>(
  { element }: UiRenderAdapter<E>, label: string, attributes: ComponentAttributes, children: Children<E> = [], tag = "div"
): E {
  return element(tag, { role: "tablist", "aria-label": label, ...attributes }, children);
}

export function Tab<E>(
  adapter: UiRenderAdapter<E>, selected: boolean, attributes: ComponentAttributes, children: Children<E>
): E {
  return Button(adapter, { role: "tab", "aria-selected": String(selected), ...attributes }, children);
}

export function Menu<E>(
  { element }: UiRenderAdapter<E>, label: string, attributes: ComponentAttributes, children: Children<E> = []
): E {
  return element("div", { role: "menu", "aria-label": label, hidden: true, ...attributes }, children);
}

export function MenuTrigger<E>(
  adapter: UiRenderAdapter<E>, menuId: string, attributes: ComponentAttributes, children: Children<E>
): E {
  return Button(adapter, { "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": menuId, ...attributes }, children);
}

export function MenuItem<E>(adapter: UiRenderAdapter<E>, attributes: ComponentAttributes, children: Children<E>): E {
  return Button(adapter, { role: "menuitem", tabindex: "-1", ...attributes }, children);
}
