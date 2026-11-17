import * as vscode from "vscode";
import { attachmentByteLimit, MAX_ATTACHMENT_BYTES } from "../../shared/lib/attachmentStore.js";
import { toCodeRef } from "../node/codeRef.js";
import type { TextSnapshot } from "../../shared/contracts/context.js";
import {
  atReferenceOccurrences,
  formatDextFileReference,
  formatDextFilePathReference,
  formatDextDirectoryReference
} from "../../features/workspace/domain/fileReference.js";
import type { DextFileReference } from "../../shared/contracts/fileReference.js";
import type { CodeRef, Range } from "../../shared/contracts/types.js";

export interface AttachmentSnapshot {
  reference: CodeRef;
  text: string;
}

export interface SelectionTarget {
  uri: string;
  version: number;
  range: Range;
}

function rangeValue(range: vscode.Range): Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

async function documentSnapshot(uri: vscode.Uri, range?: vscode.Range, expectedVersion?: number): Promise<TextSnapshot> {
  const document = await vscode.workspace.openTextDocument(uri);
  if (expectedVersion !== undefined && document.version !== expectedVersion) {
    throw new Error("The selected text has changed. Select it again before adding it to Dext.");
  }
  const content = range ? document.getText(range) : document.getText();
  const limit = attachmentByteLimit(vscode.workspace.getConfiguration("dext")
    .get<number>("attachments.maxBytes", MAX_ATTACHMENT_BYTES));
  if (new TextEncoder().encode(content).byteLength > limit) {
    throw new Error(`Attachments must be ${limit} bytes or smaller.`);
  }
  return {
    uri: document.uri.toString(),
    content,
    version: document.version,
    ...(range ? { range: rangeValue(range) } : {})
  };
}

export async function selectionAttachment(target?: SelectionTarget): Promise<AttachmentSnapshot> {
  const editor = vscode.window.activeTextEditor;
  if (!target && (!editor || editor.selection.isEmpty)) throw new Error("Select text before adding it to Dext.");
  const uri = target ? vscode.Uri.parse(target.uri, true) : editor!.document.uri;
  const selection = target
    ? new vscode.Range(target.range.start.line, target.range.start.character, target.range.end.line, target.range.end.character)
    : editor!.selection;
  const snapshot = await documentSnapshot(uri, selection, target?.version);
  return {
    text: snapshot.content,
    reference: toCodeRef(snapshot)
  };
}

/** Any active editor selection can supply a reference, inside or outside the
 * workspace. A local external file is referenced by its file URI. */
export function activeSelection(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor && !editor.selection.isEmpty ? editor : undefined;
}

/** The local file a document names. Dext's own plans and attachments live in the
 * user data directory, which VS Code opens as `vscode-userdata:`, so the scheme
 * alone does not say whether there is a file an agent can read. `git:` and
 * local-history documents hold content the file on disk does not have.
 * `undefined` means no path exists and the caller keeps plain text. */
function localFile(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme === "file") return uri;
  return uri.scheme === "vscode-userdata" && /^(?:[a-z]:[\\/]|\/)/i.test(uri.fsPath)
    ? vscode.Uri.file(uri.fsPath)
    : undefined;
}

/** Selections Dext saw recently, newest last. Pasting into the Dext input gives
 * that Webview the focus, so `window.activeTextEditor` can be gone by then.
 * More than one is kept because activating another editor reports its own
 * selection, which must not evict the copy the user is about to paste. */
const recentSelections: SelectionTarget[] = [];
const MAX_RECENT_SELECTIONS = 8;

function selectionTarget(editor: vscode.TextEditor): SelectionTarget {
  return {
    uri: editor.document.uri.toString(),
    version: editor.document.version,
    range: rangeValue(editor.selection)
  };
}

export function rememberSelection(editor: vscode.TextEditor | undefined): void {
  if (!editor?.selection || editor.selection.isEmpty) return;
  recentSelections.push(selectionTarget(editor));
  if (recentSelections.length > MAX_RECENT_SELECTIONS) recentSelections.shift();
}

/** The selection whose text is exactly what the clipboard holds: the active
 * editor's when it still has one, otherwise the most recent one Dext saw.
 * Anything else stays ordinary text. */
export async function pastedSelection(text: string): Promise<SelectionTarget | undefined> {
  const editor = activeSelection();
  const candidates = [editor ? selectionTarget(editor) : undefined, ...recentSelections.slice().reverse()];
  for (const target of candidates) {
    if (!target) continue;
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri, true));
      const range = new vscode.Range(
        target.range.start.line, target.range.start.character, target.range.end.line, target.range.end.character
      );
      // A document edited since the copy still supplies the reference when the
      // text matches; the snapshot only reports the range it was copied from.
      if (document.getText(range) === text) return { ...target, version: document.version };
    } catch {
      // A document Dext cannot open cannot stand in for this copy.
    }
  }
  return undefined;
}

/** A reference is only a path token. Do not read the file just to create it: the
 * agent can inspect a large file on demand, while pasted content continues to be
 * bounded before Dext stores it.
 * `undefined` means the resource has no path an agent could open — a diff, a
 * local-history snapshot, an unsaved editor. */
function fileReference(path: string, range?: Range): DextFileReference {
  return range ? formatDextFileReference(path, range) : formatDextFilePathReference(path);
}

/** `range` comes from a reference that already carried one, which is how a
 * pasted `@file:///…#L1,1-L2,5` token keeps its lines. */
export async function fileAttachment(uri: vscode.Uri, range?: Range): Promise<DextFileReference | undefined> {
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error("Choose a file, not a directory.");
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    const file = localFile(uri);
    return file ? fileReference(file.toString(), range) : undefined;
  }
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const reference = fileReference(vscode.workspace.asRelativePath(uri, includeWorkspaceFolder), range);
  // Spaces and punctuation must not split a file chip into a partial path.
  // An encoded local URI still references the original file without a copy.
  if (atReferenceOccurrences(reference.expression)[0]?.expression !== reference.expression) {
    const file = localFile(uri);
    if (file) return fileReference(file.toString(), range);
  }
  return reference;
}

export async function directoryAttachment(uri: vscode.Uri): Promise<DextFileReference> {
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) === 0) throw new Error("Choose a directory for ref.dir.");
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    const directory = localFile(uri);
    if (!directory) throw new Error("Only local directories can be added to Dext.");
    return formatDextDirectoryReference(directory.toString());
  }
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return formatDextDirectoryReference(vscode.workspace.asRelativePath(uri, includeWorkspaceFolder));
}

export function clipboardFileReference(reference: CodeRef): DextFileReference | undefined {
  if (!reference.range) return undefined;
  const uri = vscode.Uri.parse(reference.uri, true);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    const file = localFile(uri);
    return file ? formatDextFileReference(file.toString(), reference.range) : undefined;
  }
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const relativePath = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
  return formatDextFileReference(relativePath, reference.range);
}

export function attachmentFileReference(snapshot: AttachmentSnapshot): DextFileReference | undefined {
  const uri = vscode.Uri.parse(snapshot.reference.uri, true);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    const file = localFile(uri);
    if (!file) return undefined;
    return snapshot.reference.range
      ? formatDextFileReference(file.toString(), snapshot.reference.range)
      : formatDextFilePathReference(file.toString());
  }
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const path = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
  return snapshot.reference.range
    ? formatDextFileReference(path, snapshot.reference.range)
    : formatDextFilePathReference(path);
}
