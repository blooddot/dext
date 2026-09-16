import { randomBytes } from "node:crypto";

const escapeAttribute = (value: string): string => value.replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export interface EditorTabHtmlOptions {
  /**
   * Allows the sandboxed Archify viewer iframe. The srcdoc document inherits this policy, so it
   * also needs inline styles, data fonts and data/blob images for the self-contained artifact.
   */
  embedFrames?: boolean;
}

/** Shared document shell for new and restored Project and resource editor pages. */
export function renderEditorTabHtml(body: string, stylesheetUri: string, cspSource: string, options: EditorTabHtmlOptions = {}): string {
  const nonce = randomBytes(16).toString("hex");
  const policy = options.embedFrames
    ? `default-src 'none'; style-src ${escapeAttribute(cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; `
      + `frame-src 'self'; font-src data:; img-src data: blob:; connect-src 'none';`
    : `default-src 'none'; style-src ${escapeAttribute(cspSource)}; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    + `<meta http-equiv="Content-Security-Policy" content="${policy}">`
    + `<link rel="stylesheet" href="${escapeAttribute(stylesheetUri)}">`
    + `</head><body class="editor-tab">${body.replaceAll("<script>", `<script nonce="${nonce}">`)}</body></html>`;
}
