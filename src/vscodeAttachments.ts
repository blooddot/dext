import * as vscode from "vscode";
import { attachmentByteLimit, MAX_ATTACHMENT_BYTES } from "./attachmentStore.js";
import { toCodeRef, type TextSnapshot } from "./core/contextResolver.js";
import {
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

/** Source and configuration documents make useful file references. Prose,
 * rendered output, and delimited data do not: pasting those should preserve
 * the exact text a user copied. */
export function isCodeDocument(document: Pick<vscode.TextDocument, "languageId">): boolean {
  return !new Set([
    "plaintext",
    "markdown",
    "log",
    "output",
    "csv",
    "tsv",
    "scminput",
    "git-commit",
    "git-rebase",
    "search-result",
    "todo"
  ]).has(document.languageId);
}

function rangeValue(range: vscode.Range): Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

async function documentSnapshot(uri: vscode.Uri, range?: vscode.Range): Promise<TextSnapshot> {
  const document = await vscode.workspace.openTextDocument(uri);
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

export async function selectionAttachment(): Promise<AttachmentSnapshot> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) throw new Error("Select text before adding it to Dext.");
  const uri = editor.document.uri;
  const selection = editor.selection;
  const snapshot = await documentSnapshot(uri, selection);
  return {
    text: snapshot.content,
    reference: toCodeRef(snapshot)
  };
}

export function activeCodeSelection(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor && !editor.selection.isEmpty && isCodeDocument(editor.document) ? editor : undefined;
}

/** A workspace file reference is only a path token. Do not read the file just
 * to create it: the agent can inspect a large file on demand, while pasted
 * content continues to be bounded before Dext stores it. */
export async function fileAttachment(uri: vscode.Uri): Promise<DextFileReference> {
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    throw new Error("Dext files must stay inside the current workspace.");
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error("Choose a file, not a directory.");
  const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return formatDextFilePathReference(vscode.workspace.asRelativePath(uri, includeWorkspaceFolder));
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
