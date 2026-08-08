import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextHost, TextSnapshot } from "./core/contextResolver.js";
import type { Range } from "./core/types.js";

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
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    const root = folder.uri.fsPath;
    const resolved = path.resolve(root, filePath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("@file paths must stay inside the current workspace.");
    }
    return snapshot(vscode.Uri.file(resolved));
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
}
