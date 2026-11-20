import { dextMarkdown } from "../markdown.js";
import { markdownCodeCopy } from "../markdownCopy.js";
import type { Children, ComponentAttributes, MarkupAdapter, UiRenderAdapter } from "./renderAdapter.js";

export function Trace<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>, attributes: ComponentAttributes = {}, tag = "ul"
): E {
  return element(tag, tag === "ul" || tag === "ol" ? attributes : { role: "list", ...attributes }, children);
}

export function TraceCollapsible<E>(
  { element }: UiRenderAdapter<E>, trigger: E, content: Children<E>, attributes: ComponentAttributes = {}
): E {
  return element("details", attributes, [trigger, ...content]);
}

export function TraceCollapsibleTrigger<E>(
  { element }: UiRenderAdapter<E>, children: Children<E>, attributes: ComponentAttributes = {}
): E {
  return element("summary", attributes, children);
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

export function Text(text: string): string {
  return text;
}

const trustedMarkdown = dextMarkdown();
const copyableMarkdown = dextMarkdown().use(markdownCodeCopy);
const inertMarkdown = dextMarkdown();
// Strip destinations at render time, including URLs markdown-it normally
// rejects. The generated HTML never uses a link or image element.
inertMarkdown.validateLink = () => true;
inertMarkdown.renderer.rules.link_open = () => "";
inertMarkdown.renderer.rules.link_close = () => "";
inertMarkdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
  inertMarkdown.utils.escapeHtml(renderer.renderInlineAsText(tokens[index]!.children ?? [], options, env));

export function Markdown<E>(
  { markup }: MarkupAdapter<E>, source: string,
  { trustedLinks, copyCode = false, attributes = { class: "markdown-body" }, tag = "div" }: {
    trustedLinks: boolean; copyCode?: boolean; attributes?: ComponentAttributes; tag?: string;
  },
  children: Children<E> = []
): E {
  const renderer = trustedLinks ? (copyCode ? copyableMarkdown : trustedMarkdown) : inertMarkdown;
  return markup(tag, attributes, renderer.render(source), children);
}

export function inertMarkdownText(source: string): string {
  const visible = (token: ReturnType<typeof inertMarkdown.parse>[number]): string => {
    if (token.children) return token.children.map(visible).join("");
    if (token.type === "softbreak" || token.type === "hardbreak") return "\n";
    return ["text", "text_special", "code_inline", "fence", "code_block"].includes(token.type) ? token.content : "";
  };
  return inertMarkdown.parse(source, {}).map(visible).filter(Boolean).join("\n").trim();
}

export function Code<E>({ element }: UiRenderAdapter<E>, code: string, attributes: ComponentAttributes = {}): E {
  return element("code", attributes, [Text(code)]);
}

export function CodeBlock<E>(
  adapter: UiRenderAdapter<E>, code: string | Children<E>,
  attributes: ComponentAttributes = {}, codeAttributes: ComponentAttributes = {}
): E {
  return adapter.element("pre", attributes, typeof code === "string" ? [Code(adapter, code, codeAttributes)] : code);
}

export function Separator<E>({ element }: UiRenderAdapter<E>, attributes: ComponentAttributes = {}): E {
  return element("hr", attributes, []);
}

export function Badge<E>({ element }: UiRenderAdapter<E>, text: string, attributes: ComponentAttributes = {}): E {
  return element("span", attributes, [Text(text)]);
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
