import * as vscode from "vscode";
import { extname } from "node:path";
import type { ContextHost, TextSnapshot } from "./core/contextResolver.js";
import { parseFileReference } from "./core/fileReference.js";
import type { DirRef, Range } from "./core/types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function toRange(range: vscode.Range): Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

async function snapshot(
  uri: vscode.Uri,
  range?: vscode.Range,
  symbol?: string
): Promise<TextSnapshot> {
  const document = await vscode.workspace.openTextDocument(uri);
  const content = range ? document.getText(range) : document.getText();
  return {
    uri: document.uri.toString(),
    content,
    version: document.version,
    ...(range ? { range: toRange(range) } : {}),
    ...(symbol ? { symbol } : {})
  };
}

function workspaceFileUri(filePath: string): { uri: vscode.Uri; range?: vscode.Range } | undefined {
  const parsed = parseFileReference(filePath);
  const folders = vscode.workspace.workspaceFolders;
  let folder = folders?.[0];
  if (!folder) return undefined;
  const normalized = parsed.path.replaceAll("\\", "/");
  let segments = normalized.split("/");
  if (folders && folders.length > 1) {
    const matchingFolder = folders.find((candidate) => candidate.name === segments[0]);
    if (matchingFolder) {
      folder = matchingFolder;
      segments = segments.slice(1);
    }
  }
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || segments.length === 0
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("ref.file paths must stay inside the current workspace.");
  }
  const uri = vscode.Uri.joinPath(folder.uri, ...segments);
  const range = parsed.range
    ? new vscode.Range(
      parsed.range.start.line,
      parsed.range.start.character,
      parsed.range.end.line,
      parsed.range.end.character
    )
    : undefined;
  return { uri, ...(range ? { range } : {}) };
}

function workspaceDirectoryUri(directoryPath: string): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  let folder = folders?.[0];
  if (!folder) return undefined;
  const normalized = directoryPath.replaceAll("\\", "/");
  let segments = normalized.split("/");
  if (folders && folders.length > 1) {
    const matchingFolder = folders.find((candidate) => candidate.name === segments[0]);
    if (matchingFolder) {
      folder = matchingFolder;
      segments = segments.slice(1);
    }
  }
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error("ref.dir paths must stay inside the current workspace.");
  }
  return vscode.Uri.joinPath(folder.uri, ...segments);
}

async function validatedDocumentRange(
  uri: vscode.Uri,
  range?: vscode.Range
): Promise<{ document: vscode.TextDocument; range?: vscode.Range }> {
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    throw new Error("Files must stay inside the current workspace.");
  }
  const document = await vscode.workspace.openTextDocument(uri);
  if (range && !document.validateRange(range).isEqual(range)) {
    throw new Error("ref.file range is outside the target document.");
  }
  return { document, ...(range ? { range } : {}) };
}

export async function openWorkspaceDocument(uri: vscode.Uri, range?: Range): Promise<void> {
  const vscodeRange = range
    ? new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
    : undefined;
  const validated = await validatedDocumentRange(uri, vscodeRange);
  const editor = await vscode.window.showTextDocument(validated.document);
  if (validated.range) {
    editor.selection = new vscode.Selection(validated.range.start, validated.range.end);
    editor.revealRange(validated.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

export async function openWorkspaceFileReference(filePath: string): Promise<void> {
  const target = workspaceFileUri(filePath);
  if (!target) throw new Error("Open a workspace before opening a ref.file reference.");
  if (!target.range && IMAGE_EXTENSIONS.has(extname(target.uri.fsPath).toLowerCase())) {
    await vscode.commands.executeCommand("vscode.open", target.uri);
    return;
  }
  const validated = await validatedDocumentRange(target.uri, target.range);
  const editor = await vscode.window.showTextDocument(validated.document);
  if (validated.range) {
    editor.selection = new vscode.Selection(validated.range.start, validated.range.end);
    editor.revealRange(validated.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

export class VsCodeContextHost implements ContextHost {
  async selection(): Promise<TextSnapshot | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    return snapshot(editor.document.uri, editor.selection);
  }

  async activeFile(): Promise<TextSnapshot | undefined> {
    const editor = vscode.window.activeTextEditor;
    return editor ? snapshot(editor.document.uri) : undefined;
  }

  async file(filePath: string): Promise<TextSnapshot | undefined> {
    const target = workspaceFileUri(filePath);
    if (!target) return undefined;
    if (!target.range) return snapshot(target.uri);
    const { document, range } = await validatedDocumentRange(target.uri, target.range);
    if (!range) return undefined;
    return {
      uri: target.uri.toString(),
      content: document.getText(range),
      version: document.version,
      range: toRange(range)
    };
  }

  async symbol(name: string): Promise<TextSnapshot | undefined> {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      name
    );
    const match = symbols?.find((symbol) => symbol.name === name) ?? symbols?.[0];
    if (!match) {
      return undefined;
    }
    return snapshot(match.location.uri, match.location.range, match.name);
  }

  async dir(directoryPath: string): Promise<DirRef | undefined> {
    const uri = workspaceDirectoryUri(directoryPath);
    if (!uri || !vscode.workspace.getWorkspaceFolder(uri)) return undefined;
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) === 0) {
      throw new Error("ref.dir requires a workspace directory.");
    }
    return { kind: "dirRef", uri: uri.toString(), path: directoryPath.replaceAll("\\", "/") };
  }
}
