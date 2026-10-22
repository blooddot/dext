import MarkdownIt from "markdown-it";
import { renderMarkdownDiagrams } from "../../../platform/browser/markdownDiagrams.js";

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
    // A form can sit in a dialog or below the fold; lazy loading would then
    // never request the image, so a broken link could not report itself.
    image.loading = "eager";
    // Existing Markdown image links retain their destination. Otherwise the
    // conversation's delegated link handler can open the original attachment.
    if (!image.closest("a")) {
      const link = document.createElement("a");
      link.href = image.getAttribute("src")!;
      link.title = "Open original image";
      image.replaceWith(link);
      link.append(image);
    }
    let failed = false;
    const showFallback = (): void => {
      if (failed) return;
      failed = true;
      const fallback = document.createElement("span");
      fallback.className = "interaction-image-error";
      fallback.textContent = `Image unavailable (link may have expired): ${image.alt || "Open original image"}`;
      image.replaceWith(fallback);
    };
    image.addEventListener("error", showFallback, { once: true });
    // `decode()` also reports a failure whose `error` event fired before this
    // listener was attached, which happens with a cached failing URL.
    image.decode?.().catch(showFallback);
    // A cached or lazy image can finish failing before the listener above is
    // attached; `complete` with no intrinsic size is the same failure signal.
    if (image.complete && image.naturalWidth === 0) showFallback();
  }
  renderMarkdownDiagrams(body);
  return body;
}
