import * as vscode from "vscode";
import type { FileSearchRequest, FileSearchResponse } from "../contracts/fileSearch.js";
import { rankFileMatches } from "../domain/fileSearch.js";
const MAX_INDEXED_FILES = 20000;
const MAX_FILE_SUGGESTIONS = 40;
const FILE_INDEX_EXCLUDE = "**/{node_modules,.git,dist,out,build,.venv,__pycache__,.dext/attachments}/**";
/** A file watcher cannot exclude folders, so the same folders findFiles skips are filtered here. */
const EXCLUDED_PATH = /^(?:[^/]+\/)*(?:node_modules|\.git|dist|out|build|\.venv|__pycache__)\/|^\.dext\/attachments\//;
export class FileSearchController {
  private fileIndex: string[] | undefined;
  private fileIndexLoading: Promise<readonly string[]> | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private latestRequestId = -1;
  private disposed = false;
  constructor(private readonly post: (response: FileSearchResponse) => Promise<unknown>) { }
  async search(request: FileSearchRequest): Promise<void> {
    if (this.disposed || request.requestId < this.latestRequestId) return;
    this.latestRequestId = request.requestId;
    const paths = await this.workspaceFileIndex();
    if (this.disposed || request.requestId !== this.latestRequestId) return;
    await this.post({ type: "searchFilesResult", requestId: request.requestId, files: rankFileMatches(paths, request.query, MAX_FILE_SUGGESTIONS) });
  }
  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
    this.fileIndex = undefined;
    this.latestRequestId++;
  }
  /** A file outside every workspace folder has no reference Dext can build. */
  private relativePath(uri: vscode.Uri): string | undefined {
    // A file outside every workspace folder has no reference Dext can build.
    if (!vscode.workspace.getWorkspaceFolder(uri)) return undefined;
    return vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
  }
  private async workspaceFileIndex(): Promise<readonly string[]> {
    if (this.fileIndex) return this.fileIndex;
    if (this.fileIndexLoading) return this.fileIndexLoading;
    this.fileIndexLoading = (async () => {
      let paths: string[];
      try {
        const uris = await vscode.workspace.findFiles("**/*", FILE_INDEX_EXCLUDE, MAX_INDEXED_FILES);
        paths = uris.flatMap((uri) => this.relativePath(uri) ?? []);
      } catch {
        // A failed listing must leave the composer usable, not raise an error
        // banner over a keystroke the user did not think of as a command.
        paths = [];
      }
      // An empty or failed listing stays unindexed so the next keystroke retries it.
      if (!this.disposed && paths.length) {
        this.fileIndex = paths;
        this.watch();
      }
      return paths;
    })();
    try {
      return await this.fileIndexLoading;
    } finally {
      this.fileIndexLoading = undefined;
    }
  }
  /** Walk the workspace once, then follow the file system instead of rescanning it.
   * shortcut: only create/delete are followed, a rename arrives as both; if a
   * provider reports neither, a TTL rebuild is the fallback. */
  private watch(): void {
    if (this.watcher || this.disposed) return;
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.watcher = watcher;
    watcher.onDidCreate((uri) => {
      const relative = this.relativePath(uri);
      const paths = this.fileIndex;
      if (this.disposed || !paths || !relative || EXCLUDED_PATH.test(relative)) return;
      if (paths.length < MAX_INDEXED_FILES && !paths.includes(relative)) paths.push(relative);
    });
    watcher.onDidDelete((uri) => {
      const relative = this.relativePath(uri);
      const paths = this.fileIndex;
      const index = paths && relative ? paths.indexOf(relative) : -1;
      if (paths && index >= 0) paths.splice(index, 1);
    });
  }
}
