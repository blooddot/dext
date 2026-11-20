import type { MarkupAdapter } from "../../shared/lib/ui/renderAdapter.js";

/** Inject the owning document so the same components can render in any webview. */
export function domUiAdapter(document: Document): MarkupAdapter<HTMLElement> {
  const adapter: MarkupAdapter<HTMLElement> = {
    element: (tag, attributes, children) => {
      const element = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== false) element.setAttribute(key, value === true ? "" : value);
      }
      element.append(...children);
      return element;
    },
    markup: (tag, attributes, html, children) => {
      const element = adapter.element(tag, attributes, []);
      element.insertAdjacentHTML("afterbegin", html);
      element.append(...children);
      return element;
    }
  };
  return adapter;
}
