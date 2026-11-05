import { randomBytes } from "node:crypto";
import { escapeHtml as escapeAttribute } from "../../shared/lib/html.js";
import type { DextAppearance } from "../../shared/contracts/appearance.js";

export interface EditorTabHtmlOptions {
  /** Local Mermaid bundle; its SVG styles require inline styles, but no frames or network. */
  scriptUri?: string;
  /** Shared Mermaid bundle loaded on demand by `main.js` or `apiFlow.js`. */
  mermaidUri?: string;
  /** Shared appearance stylesheet and host-theme sync bundle. The choice itself
   * is made from the sidebar's view title, so editor pages only need the shell
   * attribute (to avoid a first-paint flash) and the broadcast listener. */
  appearance?: {
    theme: DextAppearance;
    stylesheetUri: string;
    scriptUri: string;
  };
}

/** Shared document shell for new and restored resource editor pages. */
export function renderEditorTabHtml(body: string, stylesheetUri: string, cspSource: string, options: EditorTabHtmlOptions = {}): string {
  const nonce = randomBytes(16).toString("hex");
  const policy = `default-src 'none'; style-src ${escapeAttribute(cspSource)}${options.scriptUri ? " 'unsafe-inline'" : ""}; script-src 'nonce-${nonce}';`;
  const appearance = options.appearance;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    + `<meta http-equiv="Content-Security-Policy" content="${policy}">`
    + `<meta name="dext-script-nonce" content="${nonce}">`
    + (options.mermaidUri ? `<meta name="dext-mermaid" content="${escapeAttribute(options.mermaidUri)}">` : "")
    + `<link rel="stylesheet" href="${escapeAttribute(stylesheetUri)}">`
    + (appearance ? `<link rel="stylesheet" href="${escapeAttribute(appearance.stylesheetUri)}">` : "")
    + `</head><body class="editor-tab"${appearance ? ` data-dext-theme="${appearance.theme}"` : ""}>`
    + body.replaceAll("<script>", `<script nonce="${nonce}">`)
    + (appearance ? `<script nonce="${nonce}" src="${escapeAttribute(appearance.scriptUri)}"></script>` : "")
    + (options.scriptUri ? `<script nonce="${nonce}" src="${escapeAttribute(options.scriptUri)}"></script>` : "") + `</body></html>`;
}
