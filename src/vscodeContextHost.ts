import * as vscode from "vscode";
import { extname } from "node:path";
import type { ContextHost, TextSnapshot } from "./core/contextResolver.js";
import { parseFileReference } from "./core/fileReference.js";
import type { DirRef, Range } from "./core/types.js";
import type { DextStorage } from "./dextStorage.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

function localFileLink(value: string): { path: string; range?: Range } | undefined {
  const absolute = /^[A-Za-z]:[\\/]/.test(value) || (value.startsWith("/") && !value.startsWith("//"));
  if (!absolute) return undefined;
  // Dext's output links use `path:line` or `path:line:column`. The final
  // numeric suffix is unambiguous for the paths emitted by the providers.
  const location = /:(\d+)(?::(\d+))?$/.exec(value);
  const path = location ? value.slice(0, location.index) : value;
  if (!/^[A-Za-z]:[\\/]/.test(path) && !(path.startsWith("/") && !path.startsWith("//"))) return undefined;
  if (!location) return { path };
  const line = Number(location[1]);
  const character = Number(location[2] ?? "1");
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line < 1 || character < 1) {
    return { path };
  }
  const point = { line: line - 1, character: character - 1 };
  return { path, range: { start: point, end: point } };
}

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
  const absoluteUri = /^file:\/\//i.test(parsed.path)
    ? vscode.Uri.parse(parsed.path, true)
    : /^[A-Za-z]:[\\/]/.test(parsed.path) || (parsed.path.startsWith("/") && !parsed.path.startsWith("//"))
      ? vscode.Uri.file(parsed.path)
      : undefined;
  if (absoluteUri) {
    const range = parsed.range
      ? new vscode.Range(
        parsed.range.start.line,
        parsed.range.start.character,
        parsed.range.end.line,
        parsed.range.end.character
      )
      : undefined;
    return { uri: absoluteUri, ...(range ? { range } : {}) };
  }
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
  range?: vscode.Range,
  workspaceOnly = true
): Promise<{ document: vscode.TextDocument; range?: vscode.Range }> {
  if (workspaceOnly && !vscode.workspace.getWorkspaceFolder(uri)) {
    throw new Error("Files must stay inside the current workspace.");
  }
  const document = await vscode.workspace.openTextDocument(uri);
  if (range && !document.validateRange(range).isEqual(range)) {
    throw new Error("ref.file range is outside the target document.");
  }
  return { document, ...(range ? { range } : {}) };
}

export async function openWorkspaceDocument(uri: vscode.Uri, range?: Range, workspaceOnly = true): Promise<void> {
  const vscodeRange = range
    ? new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
    : undefined;
  const validated = await validatedDocumentRange(uri, vscodeRange, workspaceOnly);
  const editor = await vscode.window.showTextDocument(validated.document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Active
  });
  if (validated.range) {
    editor.selection = new vscode.Selection(validated.range.start, validated.range.end);
    editor.revealRange(validated.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

/** Opens a browser/email link after checking that it is an allowed URI scheme. */
export async function openExternalLink(url: string): Promise<void> {
  const uri = vscode.Uri.parse(url, true);
  if (!new Set(["http", "https", "mailto"]).has(uri.scheme.toLowerCase())) {
    throw new Error("Only HTTP(S) and mailto links can be opened from output.");
  }
  const opened = await vscode.env.openExternal(uri);
  if (!opened) {
    throw new Error("VS Code could not open this link in an external application.");
  }
}

export async function openWorkspaceFileReference(filePath: string): Promise<void> {
  const target = workspaceFileUri(filePath);
  if (!target) throw new Error("Open a workspace before opening a ref.file reference.");
  if (!target.range && IMAGE_EXTENSIONS.has(extname(target.uri.fsPath).toLowerCase())) {
    await vscode.commands.executeCommand("vscode.open", target.uri);
    return;
  }
  const validated = await validatedDocumentRange(target.uri, target.range, Boolean(vscode.workspace.getWorkspaceFolder(target.uri)));
  const editor = await vscode.window.showTextDocument(validated.document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Active
  });
  if (validated.range) {
    editor.selection = new vscode.Selection(validated.range.start, validated.range.end);
    editor.revealRange(validated.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

/** Opens a Dext-owned global plan or attachment when its reference was created
 * under global storage; ordinary references retain workspace-only validation. */
export async function openDextFileReference(filePath: string, storage: DextStorage): Promise<void> {
  filePath = filePath.trim().replace(/^@(?=\.dext(?:-global)?\/)/i, "");
  const localLink = localFileLink(filePath);
  if (localLink) return openWorkspaceDocument(vscode.Uri.file(localLink.path), localLink.range, false);
  // Markdown output may use a standard file URL instead of a workspace-relative
  // path. Keep that useful and open explicitly supplied local file references.
  try {
    const uri = vscode.Uri.parse(filePath, true);
    if (uri.scheme === "file") return openWorkspaceDocument(uri, undefined, false);
  } catch {
    // Fall through to the ordinary reference resolver, which will report an
    // invalid relative path with its usual error message.
  }
  const uri = storage.uriForReference("plans", filePath) ?? storage.uriForReference("attachments", filePath);
  if (!uri) return openWorkspaceFileReference(filePath);
  if (IMAGE_EXTENSIONS.has(extname(uri.fsPath).toLowerCase())) {
    await vscode.commands.executeCommand("vscode.open", uri);
    return;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Active
  });
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
    const { document, range } = await validatedDocumentRange(target.uri, target.range, Boolean(vscode.workspace.getWorkspaceFolder(target.uri)));
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
