import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { markdownCodeCopy } from "../src/markdownCopy.js";

describe("Markdown code copy", () => {
  it("copies individual fenced and indented blocks without surrounding prose", () => {
    const markdown = new MarkdownIt({ html: false }).use(markdownCodeCopy);
    const html = markdown.render("before\n\n```ts\nconst x = 1;\n```\n\nbetween\n\n    indented\n\nafter");
    expect(html).toContain('data-copy="const x = 1;\n"');
    expect(html).toContain('data-copy="indented\n"');
    expect(html.match(/title="Copy code block"/g)).toHaveLength(2);
    expect(html).toContain('<pre><code class="language-ts">const x = 1;\n</code></pre>');
    expect(html).not.toContain('data-copy="before');
  });

  it("escapes copied content and language labels while retaining the original renderer", () => {
    const markdown = new MarkdownIt({ html: false, highlight: () => '<span class="tok-keyword">highlighted</span>' }).use(markdownCodeCopy);
    const content = '<script>"hello" & goodbye</script>\n';
    const html = markdown.render('```x"><img\n' + content + '```');
    expect(html).toContain(`data-copy="${markdown.utils.escapeHtml(content)}"`);
    expect(html).toContain('<span class="tok-keyword">highlighted</span>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });
});
