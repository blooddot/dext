import MarkdownIt from "markdown-it";

// Saved norms are untrusted text. Keep raw HTML disabled and use MarkdownIt's
// protocol validation for links, both in the host render and browser navigation.
const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]!.content);
for (const rule of ["heading_open", "heading_close"]) {
  markdown.renderer.rules[rule] = (tokens, index, options, _env, renderer) => {
    // The workspace owns its h1; a norm's title starts at h2.
    const token = tokens[index]!;
    if (token.tag === "h1") token.tag = "h2";
    return renderer.renderToken(tokens, index, options);
  };
}

export function renderProjectMarkdown(source: string): string {
  return markdown.render(source);
}
