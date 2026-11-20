import { escapeHtml } from "../html.js";
import type { MarkupAdapter } from "./renderAdapter.js";

export interface HtmlFragment { readonly html: string }

const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

export const htmlUiAdapter: MarkupAdapter<HtmlFragment> = {
  element: (tag, attributes, children) => {
    const attrs = Object.entries(attributes).map(([key, value]) =>
      typeof value === "boolean" ? (value ? ` ${key}` : "") : ` ${key}="${escapeHtml(value)}"`).join("");
    if (VOID_ELEMENTS.has(tag.toLowerCase())) return { html: `<${tag}${attrs}>` };
    const body = children.map((child) => typeof child === "string" ? escapeHtml(child) : child.html).join("");
    return { html: `<${tag}${attrs}>${body}</${tag}>` };
  },
  markup: (tag, attributes, html, children) => htmlUiAdapter.element(tag, attributes, [{ html }, ...children])
};
