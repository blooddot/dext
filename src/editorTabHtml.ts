import { randomBytes } from "node:crypto";

const escapeAttribute = (value: string): string => value.replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

/** Shared document shell for new and restored Project and resource editor pages. */
export function renderEditorTabHtml(body: string, stylesheetUri: string, cspSource: string): string {
  const nonce = randomBytes(16).toString("hex");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeAttribute(cspSource)}; script-src 'nonce-${nonce}';">`
    + `<link rel="stylesheet" href="${escapeAttribute(stylesheetUri)}">`
    + `</head><body class="editor-tab">${body.replaceAll("<script>", `<script nonce="${nonce}">`)}</body></html>`;
}
