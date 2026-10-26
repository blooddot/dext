import { renderMermaidSvg, type DextMermaidRenderer } from "../platform/browser/mermaidRenderer.js";

/**
 * Entry for the shared Mermaid bundle.
 *
 * The conversation page and the API page are separate Webview documents, so
 * neither can import the other's bundle. Both load this one file through a
 * nonce-authorized `<script>` tag and read the renderer from the global it
 * installs. Keeping Mermaid here means the VSIX carries it once, and neither
 * `main.js` nor `apiFlow.js` grows by ~3 MB.
 */
(globalThis as typeof globalThis & { __dextMermaid?: DextMermaidRenderer }).__dextMermaid = {
  renderSvg: renderMermaidSvg
};
