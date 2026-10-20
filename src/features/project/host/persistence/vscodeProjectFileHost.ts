import * as vscode from "vscode";
import { textDecoder } from "../indexing/workspaceEvidence.js";
import type { ProjectFileHost } from "./projectStore.js";

export const textEncoder = new TextEncoder();


/** Implements {@link ProjectFileHost} over the VS Code file system rooted at the workspace folder. */
export class VscodeProjectFileHost implements ProjectFileHost {
  constructor(private readonly root: vscode.Uri) {}

  private uri(relativePath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, ...relativePath.split("/").filter(Boolean));
  }

  async readFile(relativePath: string): Promise<string | undefined> {
    try {
      return textDecoder.decode(await vscode.workspace.fs.readFile(this.uri(relativePath)));
    } catch {
      // A missing or unreadable project file falls back to defaults upstream.
      return undefined;
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length > 1) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, ...segments.slice(0, -1)));
    }
    await vscode.workspace.fs.writeFile(this.uri(relativePath), textEncoder.encode(content));
  }

  async listDirectory(relativeDir: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.uri(relativeDir));
      return entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
    } catch {
      return [];
    }
  }
}