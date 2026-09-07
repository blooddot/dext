import * as vscode from "vscode";
import type { DextFileReference } from "./core/fileReference.js";
import { directoryAttachment, fileAttachment } from "./vscodeAttachments.js";

/** Only complete, existing absolute paths qualify. A sentence mentioning a
 * path, a relative code fragment, or an unavailable file stays ordinary text. */
export async function clipboardFileReferences(text: string): Promise<DextFileReference[] | undefined> {
  const paths = text.trim().split(/\r\n|\r|\n/);
  if (!text.trim() || paths.length > 100) return undefined;
  const uris: vscode.Uri[] = [];
  for (const line of paths) {
    const path = line.replace(/^"(.*)"$/, "$1");
    if (/^file:\/\//i.test(path) || /^vscode-remote:\/\//i.test(path)) {
      try { uris.push(vscode.Uri.parse(path, true)); } catch { return undefined; }
    } else if (/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(path)) {
      // Copy Path in a remote workspace uses the remote filesystem's path.
      const remote = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === "vscode-remote");
      uris.push(remote && path.startsWith("/")
        ? remote.uri.with({ path, query: "", fragment: "" })
        : vscode.Uri.file(path));
    } else {
      return undefined;
    }
  }
  try {
    return await Promise.all([...new Map(uris.map((uri) => [uri.toString(), uri])).values()].map(async (uri) => {
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.Directory) !== 0
        ? directoryAttachment(uri)
        : fileAttachment(uri);
    }));
  } catch {
    return undefined;
  }
}
