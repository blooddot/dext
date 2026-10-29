import * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";
import { textDecoder } from "../indexing/workspaceEvidence.js";
import type { ProjectFileHost } from "./projectStore.js";

export const textEncoder = new TextEncoder();


/** Implements {@link ProjectFileHost} over the VS Code file system rooted at the workspace folder. */
export class VscodeProjectFileHost implements ProjectFileHost {
  constructor(private readonly root: vscode.Uri) {}

  private uri(relativePath: string): vscode.Uri {
    if (!relativePath || /[\\:]/.test(relativePath) || relativePath.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Project path must stay inside the workspace.");
    return vscode.Uri.joinPath(this.root, ...relativePath.split("/").filter(Boolean));
  }

  private async checkedUri(path: string): Promise<vscode.Uri> {
    const uri = this.uri(path);
    if (uri.scheme === "file") {
      const root = await realpath(this.root.fsPath);
      let target = uri.fsPath;
      for (;;) {
        try { target = await realpath(target); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = dirname(target); if (parent === target) throw error; target = parent; }
      }
      const tail = relative(root, target);
      if (tail === ".." || tail.startsWith("..\\") || tail.startsWith("../") || isAbsolute(tail)) throw new Error("Project path resolves outside the workspace.");
    }
    return uri;
  }

  async readFile(relativePath: string): Promise<string | undefined> {
    try {
      return textDecoder.decode(await vscode.workspace.fs.readFile(this.uri(relativePath)));
    } catch {
      // A missing or unreadable project file falls back to defaults upstream.
      return undefined;
    }
  }

  async readFileStrict(relativePath: string): Promise<string | undefined> {
    try {
      const uri = await this.checkedUri(relativePath);
      if ((await vscode.workspace.fs.stat(uri)).size > 16 * 1024 * 1024) throw new Error("Project document exceeds the read budget.");
      return new TextDecoder("utf-8", { fatal: true }).decode(await vscode.workspace.fs.readFile(uri));
    }
    catch (error) {
      if ((error as { code?: string }).code === "FileNotFound") return undefined;
      throw error;
    }
  }

  async listDirectoryStrict(relativeDir: string): Promise<string[]> {
    try {
      return (await vscode.workspace.fs.readDirectory(await this.checkedUri(relativeDir)))
        .filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
    } catch (error) {
      if ((error as { code?: string }).code === "FileNotFound") return [];
      throw error;
    }
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const uri = await this.checkedUri(relativePath);
    const segments = relativePath.split("/").filter(Boolean);
    if (segments.length > 1) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, ...segments.slice(0, -1)));
    }
    await vscode.workspace.fs.writeFile(uri, textEncoder.encode(content));
  }

  async deleteFile(relativePath: string): Promise<void> {
    await vscode.workspace.fs.delete(await this.checkedUri(relativePath), { recursive: false, useTrash: false });
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
