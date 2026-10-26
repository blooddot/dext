import { renderMermaidSvg } from "../../../platform/browser/markdownDiagrams.js";

/**
 * Renders every Execution flow on the page. The host deliberately ships only
 * Mermaid source; this is the one Webview entry that loads Mermaid, so API pages
 * pay for it only when they actually contain a flow.
 */
async function renderFlow(root: HTMLElement): Promise<void> {
  const preview = root.querySelector<HTMLElement>("[data-api-flow-preview]");
  const status = root.querySelector<HTMLElement>("[data-api-flow-status]");
  const details = root.querySelector<HTMLDetailsElement>("[data-api-flow-source-details]");
  const source = root.querySelector<HTMLElement>("[data-api-flow-source]")?.textContent ?? "";
  if (!preview || !source.trim()) {
    if (status) status.textContent = "Unable to render execution flow: the Mermaid source is missing.";
    if (details) details.open = true;
    root.dataset.apiFlowState = "error";
    return;
  }
  try {
    const svg = await renderMermaidSvg(source, root);
    if (!root.isConnected) return;
    preview.innerHTML = svg;
    status?.remove();
    root.dataset.apiFlowState = "ready";
  } catch {
    if (status) status.textContent = "Unable to render execution flow. Check the Mermaid source below.";
    if (details) details.open = true;
    root.dataset.apiFlowState = "error";
  }
}

for (const root of document.querySelectorAll<HTMLElement>("[data-api-flow]")) void renderFlow(root);
