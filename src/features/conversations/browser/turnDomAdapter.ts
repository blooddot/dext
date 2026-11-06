import type { TurnRenderAdapter } from "../presentation/turnComponents.js";

/** The document is injected so importing shared components never requires a
 * browser. The adapter lives in the browser folder because only the rendered
 * conversation page calls it. */
export function turnDomAdapter(document: Document): TurnRenderAdapter<HTMLElement> {
  return {
    element: (tag, attributes, children) => {
      const element = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== false) element.setAttribute(key, value === true ? "" : value);
      }
      element.append(...children);
      return element;
    }
  };
}
