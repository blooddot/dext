import { join } from "node:path";
import * as vscode from "vscode";
import { workspaceFileUri } from "./contextHost.js";

/** How many turns of one conversation keep their file copies. They are content,
 * not history: enough to keep recent per-turn diffs readable, bounded on disk. */
const KEEP_TURNS = 100;

/** Copies the files each turn changed, so a turn can be compared with its own
 * starting point instead of the last commit. */
export class TurnSnapshots {
  private readonly root: string;

  constructor(storage: vscode.Uri) {
    this.root = join(storage.fsPath, "turn-changes");
  }

  /** `path` is workspace-relative, which is also a valid relative path below the
   * turn's own directory. */
  private file(sessionId: string, turnId: string, path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.turnDirectory(sessionId, turnId), ...path.split("/"));
  }

  /** The turn's own directory. It doubles as the stable id of the turn's diff
   * tab, so clicking another file of the same turn reuses that tab. */
  turnDirectory(sessionId: string, turnId: string): vscode.Uri {
    return vscode.Uri.file(join(this.root, sessionId, turnId));
  }

  async save(sessionId: string, turnId: string, paths: readonly string[]): Promise<void> {
    const directory = this.turnDirectory(sessionId, turnId);
    for (const path of paths) {
      try {
        const source = workspaceFileUri(path)?.uri;
        if (!source) continue;
        await vscode.workspace.fs.createDirectory(directory);
        await vscode.workspace.fs.writeFile(this.file(sessionId, turnId, path), await vscode.workspace.fs.readFile(source));
      } catch {
        // Deleted since the turn, unreadable, or outside the workspace.
      }
    }
    await this.prune(sessionId);
  }

  async find(sessionId: string, turnId: string, path: string): Promise<vscode.Uri | undefined> {
    const uri = this.file(sessionId, turnId, path);
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      return undefined;
    }
  }

  /** What a turn's diff shows on its right: the project file itself when it still
   * holds exactly the turn's last content, so VS Code's own "open file" opens the
   * real file; once the file changed since, only the copy is that turn's content. */
  async end(sessionId: string, turnId: string, path: string): Promise<vscode.Uri | undefined> {
    const copy = await this.find(sessionId, turnId, path);
    try {
      const live = workspaceFileUri(path)?.uri;
      if (!live) return copy;
      if (!copy) return live;
      const same = Buffer.compare(
        await vscode.workspace.fs.readFile(live),
        await vscode.workspace.fs.readFile(copy)
      ) === 0;
      return same ? live : copy;
    } catch {
      return copy;
    }
  }

  /** shortcut: pruned by turn count, not by history retention, so a deleted
   * conversation keeps its copies until newer turns push them out. */
  private async prune(sessionId: string): Promise<void> {
    try {
      const directory = vscode.Uri.file(join(this.root, sessionId));
      const turns = await vscode.workspace.fs.readDirectory(directory);
      if (turns.length <= KEEP_TURNS) return;
      const dated: { uri: vscode.Uri; mtime: number }[] = [];
      for (const [name] of turns) {
        const uri = vscode.Uri.joinPath(directory, name);
        dated.push({ uri, mtime: (await vscode.workspace.fs.stat(uri)).mtime });
      }
      dated.sort((a, b) => a.mtime - b.mtime);
      for (const entry of dated.slice(0, dated.length - KEEP_TURNS)) {
        await vscode.workspace.fs.delete(entry.uri, { recursive: true, useTrash: false });
      }
    } catch {
      // Cleanup is maintenance: never fail a turn over it.
    }
  }
}
