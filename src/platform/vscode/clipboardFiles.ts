import * as vscode from "vscode";
import type { DextFileReference } from "../../shared/contracts/fileReference.js";
import type { Range } from "../../shared/contracts/types.js";
import { parseFileReference } from "../../features/workspace/domain/fileReference.js";
import { directoryAttachment, fileAttachment } from "./attachments.js";

/** Explorer Copy Path, kept compatible with VS Code's own file copy. Copy Path
 * writes the path text Dext reads, but an Explorer paste reads VS Code's file
 * list, so the text is handed back to the caller and the file list is put on
 * the clipboard last. Returns the path text Copy Path wrote. */
export async function copyFilePathKeepingFiles(): Promise<string> {
  await vscode.commands.executeCommand("copyFilePath");
  const text = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand("filesExplorer.copy");
  } catch {
    // A VS Code without that built-in keeps the text-only clipboard: Dext Input
    // still resolves the paths, only pasting the files into an Explorer is lost.
  }
  return text;
}

/** Editor Copy Path with nothing selected, kept compatible with VS Code's own
 * copy-line behavior. The line copy runs last and the text it leaves behind is
 * what the staged path belongs to. */
export async function copyFilePathKeepingLine(): Promise<{ path: string; clipboardText: string }> {
  await vscode.commands.executeCommand("copyFilePath");
  const path = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
  } catch {
    // Keep the path text: it still serves Dext Input, only the copy-line
    // behavior is lost.
    return { path, clipboardText: path };
  }
  return { path, clipboardText: await vscode.env.clipboard.readText() };
}

/** One clipboard line as a target, or `undefined` when it is not a path.
 * A reference Dext wrote can be pasted back: the leading `@`, the quotes and the
 * `#L1,1-L2,5` range belong to the token, not to the path. */
function referenceTarget(line: string): { uri: vscode.Uri; range?: Range } | undefined {
  try {
    const parsed = parseFileReference(line.replace(/^"(.*)"$/, "$1").replace(/^@/, ""));
    const uriLike = /^(?:file|vscode-remote):\/\//i.test(parsed.path);
    // `Uri.parse` keeps whatever follows `#` as a fragment, which `toString`
    // percent-encodes into `%2C`, and a chip parser accepts no `%2C` range.
    const path = uriLike ? parsed.path.replace(/#.*$/, "") : parsed.path;
    const range = parsed.range;
    if (uriLike) return { uri: vscode.Uri.parse(path, true), ...(range ? { range } : {}) };
    if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(path)) return undefined;
    // Copy Path in a remote workspace uses the remote filesystem's path.
    const remote = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === "vscode-remote");
    const uri = remote && path.startsWith("/")
      ? remote.uri.with({ path, query: "", fragment: "" })
      : vscode.Uri.file(path);
    return { uri, ...(range ? { range } : {}) };
  } catch {
    return undefined;
  }
}

/** Only complete, existing absolute paths qualify. A sentence mentioning a
 * path, a relative code fragment, or an unavailable file stays ordinary text. */
export async function clipboardFileReferences(text: string): Promise<DextFileReference[] | undefined> {
  const paths = text.trim().split(/\r\n|\r|\n/);
  if (!text.trim() || paths.length > 100) return undefined;
  const targets: Array<{ uri: vscode.Uri; range?: Range }> = [];
  for (const line of paths) {
    const target = referenceTarget(line);
    if (!target) return undefined;
    targets.push(target);
  }
  try {
    const references = await Promise.all([...new Map(targets.map((target) => [target.uri.toString(), target])).values()]
      .map(async ({ uri, range }) => {
        const stat = await vscode.workspace.fs.stat(uri);
        return (stat.type & vscode.FileType.Directory) !== 0
          ? directoryAttachment(uri)
          : fileAttachment(uri, range);
      }));
    // A path that arrived as text always names a real file; a remote one may not.
    return references.every((reference) => reference) ? references as DextFileReference[] : undefined;
  } catch {
    return undefined;
  }
}
