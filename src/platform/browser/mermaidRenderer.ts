import mermaid from "mermaid";

/** The API the shared Mermaid bundle exposes to the page that lazy-loads it. */
export interface DextMermaidRenderer {
  renderSvg(source: string, root: HTMLElement): Promise<string>;
}

let nextDiagramId = 0;
let renderQueue = Promise.resolve();

/**
 * Render one Mermaid source with the bundled renderer.
 *
 * This module is the entry's implementation and is bundled once as
 * `dist/webview/mermaid.js`; the conversation and API pages load that file on
 * demand instead of each carrying their own copy of Mermaid. `renderQueue`
 * serializes renders per document, as Mermaid is not re-entrant.
 */
export function renderMermaidSvg(source: string, root: HTMLElement): Promise<string> {
  const result = renderQueue.then(async () => {
    const light = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
    mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      theme: light ? "default" : "dark", fontFamily: getComputedStyle(root).fontFamily,
      htmlLabels: false,
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels"]
    });
    const staging = document.createElement("div");
    staging.className = "markdown-diagram-staging";
    staging.setAttribute("aria-hidden", "true");
    document.body.append(staging);
    try { return (await mermaid.render(`dext-mermaid-${++nextDiagramId}`, source, staging)).svg; }
    finally { staging.remove(); }
  });
  renderQueue = result.then(() => undefined, () => undefined);
  return result;
}
