import * as vscode from "vscode";
import { MAX_ATTACHMENT_BYTES, type AttachmentView } from "./attachmentStore.js";
import { toCodeRef, type TextSnapshot } from "./core/contextResolver.js";
import {
  compactFileReferenceLabel,
  formatDextFileReference,
  type DextFileReference
} from "./core/fileReference.js";
import type { CodeRef, Range } from "./core/types.js";

export interface AttachmentSnapshot {
  view: Omit<AttachmentView, "id">;
  reference: CodeRef;
  text: string;
}

function rangeValue(range: vscode.Range): Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function relativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false) || uri.path.split("/").at(-1) || uri.toString();
}

function codeLabel(uri: vscode.Uri, range: vscode.Range): string {
  return compactFileReferenceLabel(formatDextFileReference(relativePath(uri), rangeValue(range)).payload);
}

async function documentSnapshot(uri: vscode.Uri, range?: vscode.Range): Promise<TextSnapshot> {
  const document = await vscode.workspace.openTextDocument(uri);
  const content = range ? document.getText(range) : document.getText();
  if (new TextEncoder().encode(content).byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachments must be ${MAX_ATTACHMENT_BYTES} bytes or smaller.`);
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
  if (!editor || editor.selection.isEmpty) throw new Error("Select code before adding it to Chat.");
  const uri = editor.document.uri;
  const selection = editor.selection;
  const snapshot = await documentSnapshot(uri, selection);
  return {
    text: snapshot.content,
    reference: toCodeRef(snapshot),
    view: {
      kind: "code",
      label: codeLabel(uri, selection),
      uri: snapshot.uri,
      ...(snapshot.range ? { range: snapshot.range } : {})
    }
  };
}

export async function fileAttachment(uri: vscode.Uri): Promise<AttachmentSnapshot> {
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    throw new Error("Chat files must stay inside the current workspace.");
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error("Choose a file, not a directory.");
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachments must be ${MAX_ATTACHMENT_BYTES} bytes or smaller.`);
  }
  const snapshot = await documentSnapshot(uri);
  return {
    text: snapshot.content,
    reference: toCodeRef(snapshot),
    view: { kind: "file", label: compactFileReferenceLabel(relativePath(uri)), uri: snapshot.uri }
  };
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
