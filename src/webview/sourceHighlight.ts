import { monaco } from "./monacoEnvironment.js";
import { DEXT_MONACO_THEME } from "./monacoTheme.js";

/**
 * Paints code in the conversation with the composer's own tokenizer and theme.
 *
 * A turn's input is a `<pre>` holding the authored source: a Code turn is TypeScript, and
 * the grammar, the theme and the reference chips around it already exist in this Webview,
 * so the same colors the user wrote it in are available here instead of a plain block of
 * text. Monaco's colorizer only rewrites text, so a chip (and anything else already an
 * element) is left exactly where it is: only the text nodes between them are colorized,
 * one at a time.
 *
 * The work is asynchronous and best-effort — the element keeps its plain text until the
 * colors arrive, so a failure is a cosmetic loss, never a missing line of source.
 */
export function colorizeSource(element: HTMLElement, language = "typescript"): void {
  const texts: Text[] = [];
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) texts.push(node as Text);
  }
  for (const node of texts) {
    const source = node.textContent ?? "";
    if (!source.trim()) continue;
    const holder = document.createElement("span");
    holder.dataset.lang = language;
    holder.textContent = source;
    void monaco.editor.colorizeElement(holder, { theme: DEXT_MONACO_THEME }).then(() => {
      // The node may have gone away while the tokenizer worked (a restored turn can be
      // re-rendered); replacing nothing then is the right answer.
      if (node.parentNode) node.replaceWith(...holder.childNodes);
    }).catch(() => undefined);
  }
}
