import * as vscode from "vscode";
import type { FileSearchRequest, FileSearchResponse } from "../contracts.js";
import { rankFileMatches } from "../domain/fileSearch.js";
const MAX_INDEXED_FILES = 20000;
const MAX_FILE_SUGGESTIONS = 40;
const FILE_INDEX_TTL_MS = 15000;
const FILE_INDEX_EXCLUDE = "**/{node_modules,.git,dist,out,build,.venv,__pycache__,.dext/attachments}/**";
export class FileSearchController {
  private fileIndex: { paths: string[]; loadedAt: number } | undefined;
  private fileIndexLoading: Promise<readonly string[]> | undefined;
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
  dispose(): void { this.disposed = true; this.fileIndex = undefined; this.latestRequestId++; }
  private async workspaceFileIndex(): Promise<readonly string[]> {
    const now = Date.now();
    if (this.fileIndex && now - this.fileIndex.loadedAt < FILE_INDEX_TTL_MS) return this.fileIndex.paths;
    if (this.fileIndexLoading) return this.fileIndexLoading;
    this.fileIndexLoading = (async () => {
      let paths: string[];
      try {
        const uris = await vscode.workspace.findFiles("**/*", FILE_INDEX_EXCLUDE, MAX_INDEXED_FILES);
        paths = uris.flatMap((uri) => {
          const relative = vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
          // A file outside every workspace folder has no reference Dext can build.
          return relative.startsWith("..") || relative.includes(":") ? [] : [relative];
        });
      } catch {
        // A failed listing must leave the composer usable, not raise an error
        // banner over a keystroke the user did not think of as a command.
        paths = [];
      }
      if (!this.disposed) this.fileIndex = { paths, loadedAt: Date.now() };
      return paths;
    })();
    try {
      return await this.fileIndexLoading;
    } finally {
      this.fileIndexLoading = undefined;
    }
  }
}
