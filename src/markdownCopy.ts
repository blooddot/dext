import type MarkdownIt from "markdown-it";

/** Keep copy controls outside pre so they stay put when long code lines scroll. */
export function markdownCodeCopy(markdown: MarkdownIt): void {
  for (const rule of ["fence", "code_block"] as const) {
    const render = markdown.renderer.rules[rule];
    if (!render) continue;
    markdown.renderer.rules[rule] = (tokens, index, options, env, renderer) => {
      const token = tokens[index]!;
      const language = token.info.trim().split(/\s+/, 1)[0] || "text";
      const escape = (value: string): string => markdown.utils.escapeHtml(value);
      return `<div class="markdown-code-block"><div class="markdown-code-toolbar"><span>${escape(language)}</span><button class="markdown-code-copy codicon codicon-copy" type="button" data-copy="${escape(token.content)}" title="Copy code block" aria-label="Copy code block"></button></div>${render(tokens, index, options, env, renderer)}</div>`;
    };
  }
}
