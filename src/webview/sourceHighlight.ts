import { monaco } from "./monacoEnvironment.js";
import { DEXT_MONACO_THEME } from "./monacoTheme.js";

/**
 * Paints code in the conversation with the composer's own tokenizer and theme.
 *
 * Colorize the whole input so strings and comments keep their state across reference
 * chips. Like the composer, temporarily project chips to private characters, then put
 * the original elements (including their click handlers) back into the colored text.
 *
 * The work is asynchronous and best-effort — the element keeps its plain text until the
 * colors arrive, so a failure is a cosmetic loss, never a missing line of source.
 */
export function colorizeSource(element: HTMLElement, language = "typescript"): void {
  const nodes = [...element.childNodes];
  const original = element.textContent ?? "";
  const chips = new Map<string, ChildNode>();
  let next = 0xe100;
  let source = "";
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      source += node.textContent;
    } else {
      while (next <= 0xf8ff && original.includes(String.fromCharCode(next))) next++;
      if (next > 0xf8ff) return;
      const marker = String.fromCharCode(next++);
      chips.set(marker, node);
      source += marker;
    }
  }
  if (!source.trim()) return;
  const holder = document.createElement("span");
  holder.dataset.lang = language;
  holder.textContent = source;
  void monaco.editor.colorizeElement(holder, { theme: DEXT_MONACO_THEME }).then(() => {
    // Do not overwrite content replaced while the tokenizer was loading.
    if (element.childNodes.length !== nodes.length || nodes.some((node, index) => element.childNodes[index] !== node)
      || element.textContent !== original) return;
    const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
    const replacements: { node: Text; parts: (string | ChildNode)[] }[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const parts = node.data.split(/([\ue100-\uf8ff])/).map(part => chips.get(part) ?? part);
      if (parts.some(part => typeof part !== "string")) replacements.push({ node, parts });
    }
    for (const { node, parts } of replacements) node.replaceWith(...parts);
    // Monaco emits a final <br> even when the source has no trailing newline.
    if (holder.lastChild?.nodeName === "BR") holder.lastChild.remove();
    element.replaceChildren(...holder.childNodes);
  }).catch(() => undefined);
}
