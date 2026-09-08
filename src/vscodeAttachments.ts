import * as vscode from "vscode";
import { attachmentByteLimit, MAX_ATTACHMENT_BYTES } from "./attachmentStore.js";
import { toCodeRef, type TextSnapshot } from "./core/contextResolver.js";
import {
  atReferenceOccurrences,
  formatDextFileReference,
  formatDextFilePathReference,
  formatDextDirectoryReference,
  type DextFileReference
} from "./core/fileReference.js";
import type { CodeRef, Range } from "./core/types.js";

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

/** Any workspace text document can supply a file reference, regardless of language.
 * External editors must remain ordinary clipboard text. */
export function activeWorkspaceSelection(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor
    && !editor.selection.isEmpty
    && vscode.workspace.getWorkspaceFolder(editor.document.uri)
    ? editor
    : undefined;
}

/** A workspace file reference is only a path token. Do not read the file just
 * to create it: the agent can inspect a large file on demand, while pasted
 * content continues to be bounded before Dext stores it. */
export async function fileAttachment(uri: vscode.Uri): Promise<DextFileReference> {
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error("Choose a file, not a directory.");
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    if (uri.scheme !== "file") throw new Error("Only local external files can be added to Dext.");
    return formatDextFilePathReference(uri.toString());
  }
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const reference = formatDextFilePathReference(vscode.workspace.asRelativePath(uri, includeWorkspaceFolder));
  // Spaces and punctuation must not split a file chip into a partial path.
  // An encoded local URI still references the original file without a copy.
  if (uri.scheme === "file" && atReferenceOccurrences(reference.expression)[0]?.expression !== reference.expression) {
    return formatDextFilePathReference(uri.toString());
  }
  return reference;
}

export async function directoryAttachment(uri: vscode.Uri): Promise<DextFileReference> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) throw new Error("Dext directories must stay inside the current workspace.");
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) === 0) throw new Error("Choose a directory for ref.dir.");
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return formatDextDirectoryReference(vscode.workspace.asRelativePath(uri, includeWorkspaceFolder));
}

export function clipboardFileReference(reference: CodeRef): DextFileReference | undefined {
  if (!reference.range) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(reference.uri, true));
  if (!folder) return undefined;
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const relativePath = vscode.workspace.asRelativePath(
    vscode.Uri.parse(reference.uri, true),
    includeWorkspaceFolder
  );
  return formatDextFileReference(relativePath, reference.range);
}

export function attachmentFileReference(snapshot: AttachmentSnapshot): DextFileReference {
  const uri = vscode.Uri.parse(snapshot.reference.uri, true);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) throw new Error("Dext references must stay inside the current workspace.");
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const path = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
  return snapshot.reference.range
    ? formatDextFileReference(path, snapshot.reference.range)
    : formatDextFilePathReference(path);
}
