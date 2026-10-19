let nextDiagramId = 0;
let renderQueue = Promise.resolve();

/** Shared renderer for conversation Markdown and the Project reader, serialized per document. */
export function renderMermaidSvg(source: string, root: HTMLElement): Promise<string> {
  const result = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
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

/** Render locally bundled Mermaid without letting one bad diagram break the form. */
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
