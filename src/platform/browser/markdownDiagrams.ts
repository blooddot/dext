import type { DextMermaidRenderer } from "./mermaidRenderer.js";

const MERMAID_META = 'meta[name="dext-mermaid"]';
const NONCE_META = 'meta[name="dext-script-nonce"]';

let renderer: Promise<DextMermaidRenderer> | undefined;

/**
 * Load the shared Mermaid bundle once per document.
 *
 * `main.js` and `apiFlow.js` deliberately contain no Mermaid code. The host puts
 * the bundle's Webview URI and the document nonce in meta tags; the first diagram
 * appends a nonce-authorized script and every later diagram reuses the global it
 * installs. The conversation and API pages each pay for Mermaid only when a
 * diagram is actually rendered.
 */
function loadMermaidRenderer(): Promise<DextMermaidRenderer> {
  if (renderer) return renderer;
  const existing = (globalThis as typeof globalThis & { __dextMermaid?: DextMermaidRenderer }).__dextMermaid;
  if (existing) {
    renderer = Promise.resolve(existing);
    return renderer;
  }
  renderer = new Promise<DextMermaidRenderer>((resolve, reject) => {
    const url = document.querySelector<HTMLMetaElement>(MERMAID_META)?.content;
    if (!url) {
      reject(new Error("The shared Mermaid bundle is not configured for this page."));
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    const nonce = document.querySelector<HTMLMetaElement>(NONCE_META)?.content;
    if (nonce) script.nonce = nonce;
    script.addEventListener("load", () => {
      const loaded = (globalThis as typeof globalThis & { __dextMermaid?: DextMermaidRenderer }).__dextMermaid;
      if (loaded) resolve(loaded);
      else reject(new Error("The shared Mermaid bundle did not register a renderer."));
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("The shared Mermaid bundle could not be loaded.")), { once: true });
    document.head.append(script);
  }).catch((error: unknown) => {
    // A transient load failure must not poison every later diagram in this page.
    renderer = undefined;
    throw error;
  });
  return renderer;
}

/** Shared renderer for conversation Markdown and API execution flows. */
export async function renderMermaidSvg(source: string, root: HTMLElement): Promise<string> {
  return (await loadMermaidRenderer()).renderSvg(source, root);
}

/** Render loaded Mermaid without letting one bad diagram break the form. */
export function renderMarkdownDiagrams(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code.language-mermaid")) {
    const pre = code.parentElement!;
    const source = code.textContent ?? "";
    const diagram = document.createElement("div");
    diagram.className = "markdown-diagram";
    const preview = document.createElement("div");
    preview.className = "markdown-diagram-preview";
    preview.setAttribute("aria-label", "Mermaid diagram");
    const status = document.createElement("p");
    status.className = "markdown-diagram-status";
    status.setAttribute("role", "status");
    status.textContent = "Rendering diagram…";
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Mermaid source";
    details.open = true;
    details.append(summary);
    pre.replaceWith(diagram);
    details.append(pre);
    diagram.append(status, preview, details);

    void (async () => {
      try {
        const svg = await renderMermaidSvg(source, root);
        if (!diagram.isConnected) return;
        preview.innerHTML = svg;
        status.remove();
        details.open = false;
        diagram.dataset.diagramState = "ready";
      } catch {
        status.textContent = "Unable to render diagram. Check the Mermaid source below.";
        details.open = true;
        diagram.dataset.diagramState = "error";
      }
    })();
  }
}
