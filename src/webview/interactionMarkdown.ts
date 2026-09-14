import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
const renderImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const token = tokens[index]!;
  // Remote task attachments use signed HTTPS URLs. Leave the URL intact.
  if (!/^https:\/\//i.test(token.attrGet("src") ?? "")) {
    return markdown.utils.escapeHtml(token.content || "Image unavailable");
  }
  token.attrSet("loading", "lazy");
  token.attrSet("referrerpolicy", "no-referrer");
  return renderImage(tokens, index, options, env, renderer);
};

/** Task notes and agent reports share the conversation's Markdown typography. */
export function interactionMarkdown(source: string): HTMLDivElement {
  const body = document.createElement("div");
  body.className = "interaction-description markdown-body";
  body.innerHTML = markdown.render(source);
  for (const image of body.querySelectorAll("img")) {
    // Existing Markdown image links retain their destination. Otherwise the
    // conversation's delegated link handler can open the original attachment.
    if (!image.closest("a")) {
      const link = document.createElement("a");
      link.href = image.getAttribute("src")!;
      link.title = "Open original image";
      image.replaceWith(link);
      link.append(image);
    }
    image.addEventListener("error", () => {
      const fallback = document.createElement("span");
      fallback.className = "interaction-image-error";
      fallback.textContent = `Image unavailable (link may have expired): ${image.alt || "Open original image"}`;
      image.replaceWith(fallback);
    }, { once: true });
  }
  return body;
}
