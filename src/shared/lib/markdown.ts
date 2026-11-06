import MarkdownIt from "markdown-it";

/** The one renderer for agent output: the live conversation, restored History,
 * todo rows and interaction cards must show the same text the same way.
 * markdown-it rejects `file:` destinations by default; the host validates those
 * URLs against the workspace before opening them, so keep them as links. */
export function dextMarkdown(): MarkdownIt {
  const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
  const validate = markdown.validateLink.bind(markdown);
  markdown.validateLink = (url: string): boolean => /^file:/i.test(url.trim()) || validate(url);
  return markdown;
}
