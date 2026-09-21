let nextDiagramId = 0;
let renderQueue = Promise.resolve();

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

    // Mermaid has shared configuration and a shared rendering scratch space.
    // Serialize initialization as well as rendering across simultaneous forms.
    renderQueue = renderQueue.then(async () => {
      let staging: HTMLDivElement | undefined;
      try {
        const { default: mermaid } = await import("mermaid");
        if (!diagram.isConnected) return;
        const light = document.body.classList.contains("vscode-light")
          || document.body.classList.contains("vscode-high-contrast-light");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: light ? "default" : "dark",
          fontFamily: getComputedStyle(root).fontFamily,
          htmlLabels: false,
          secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels"],
        });
        // Hidden dialogs and detached fragments cannot provide SVG text metrics.
        // Measure in a connected, invisible container and always remove it.
        staging = document.createElement("div");
        staging.className = "markdown-diagram-staging";
        staging.setAttribute("aria-hidden", "true");
        document.body.append(staging);
        const { svg } = await mermaid.render(`dext-mermaid-${++nextDiagramId}`, source, staging);
        if (!diagram.isConnected) return;
        preview.innerHTML = svg;
        status.remove();
        details.open = false;
        diagram.dataset.diagramState = "ready";
      } catch {
        status.textContent = "Unable to render diagram. Check the Mermaid source below.";
        details.open = true;
        diagram.dataset.diagramState = "error";
      } finally {
        staging?.remove();
      }
    });
  }
}
