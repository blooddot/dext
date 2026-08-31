import * as vscode from "vscode";
import { attachmentByteLimit, MAX_ATTACHMENT_BYTES } from "./attachmentStore.js";

export const STORAGE_LOCATIONS = ["global", "workspace"] as const;
export type StorageLocation = typeof STORAGE_LOCATIONS[number];
export type StoredDextFile = "attachments" | "plans";
export const DEFAULT_MAX_ATTACHMENT_FILES = 200;

const GLOBAL_REFERENCE_ROOT = ".dext-global";
const ATTACHMENT_FILE = /^(?:[a-f0-9]{24}\.(?:png|jpg|gif|webp|bmp)|terminal-[a-f0-9]{24}\.log)$/i;
const ATTACHMENT_REFERENCE = /@((?:\.dext-global|\.dext)\/attachments\/(?:[a-f0-9]{24}\.(?:png|jpg|gif|webp|bmp)|terminal-[a-f0-9]{24}\.log))/gi;

function safeSegments(path: string): string[] | undefined {
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.length && segments.every((segment) => segment && segment !== "." && segment !== "..")
    ? segments
    : undefined;
}

/** Resolves Dext-owned transient files independently of the workspace. Global
 * references carry their location with them, so changing the setting never
 * strands a plan or image saved under the previous choice. */
export class DextStorage {
  constructor(readonly globalStorageUri: vscode.Uri) {}

  location(): StorageLocation {
    const value = vscode.workspace.getConfiguration("dext").get<string>("storage.location", "global");
    return value === "workspace" ? "workspace" : "global";
  }

  attachmentLimit(): number {
    const value = vscode.workspace.getConfiguration("dext").get<number>("attachments.maxFiles", DEFAULT_MAX_ATTACHMENT_FILES);
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ATTACHMENT_FILES;
  }

  attachmentByteLimit(): number {
    const value = vscode.workspace.getConfiguration("dext")
      .get<number>("attachments.maxBytes", MAX_ATTACHMENT_BYTES);
    return attachmentByteLimit(value);
  }

  directory(kind: StoredDextFile): vscode.Uri {
    if (this.location() === "global") return vscode.Uri.joinPath(this.globalStorageUri, kind);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspace) throw new Error("Open a workspace to store Dext files in the project.");
    return vscode.Uri.joinPath(workspace, ".dext", kind);
  }

  reference(kind: StoredDextFile, name: string): string {
    if (!safeSegments(name)) throw new Error("Dext storage file names must not contain path traversal.");
    return this.location() === "global"
      ? `${GLOBAL_REFERENCE_ROOT}/${kind}/${name}`
      : `.dext/${kind}/${name}`;
  }

  /** Resolves both current global references and the longstanding workspace
   * `.dext/...` paths. An unrelated path is never treated as Dext storage. */
  uriForReference(kind: StoredDextFile, reference: string): vscode.Uri | undefined {
    const normalized = reference.replaceAll("\\", "/");
    const globalPrefix = `${GLOBAL_REFERENCE_ROOT}/${kind}/`;
    const workspacePrefix = `.dext/${kind}/`;
    const prefix = normalized.startsWith(globalPrefix)
      ? globalPrefix
      : normalized.startsWith(workspacePrefix) ? workspacePrefix : undefined;
    if (!prefix) return undefined;
    const segments = safeSegments(normalized.slice(prefix.length));
    if (!segments) return undefined;
    if (prefix === globalPrefix) return vscode.Uri.joinPath(this.globalStorageUri, kind, ...segments);
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    return workspace ? vscode.Uri.joinPath(workspace, ".dext", kind, ...segments) : undefined;
  }

  /** The original user text remains a compact token in history, while an agent
   * receives the on-disk path it needs to inspect an image or terminal log. */
  attachmentPrompt(input: string): string {
    const paths = [...input.matchAll(ATTACHMENT_REFERENCE)]
      .map((match) => this.uriForReference("attachments", match[1] ?? "")?.fsPath)
      .filter((path): path is string => Boolean(path));
    if (!paths.length) return input;
    return `${input}\n\nDext attachment files (read-only):\n${paths.map((path) => `- ${path}`).join("\n")}`;
  }

  async pruneAttachments(maxFiles: number, keep?: vscode.Uri): Promise<void> {
    const directory = this.directory("attachments");
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directory);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return;
      throw error;
    }
    const attachments = entries
      .filter(([name, type]) => type === vscode.FileType.File && ATTACHMENT_FILE.test(name))
      .map(([name]) => vscode.Uri.joinPath(directory, name));
    const excess = attachments.length - maxFiles;
    if (excess <= 0) return;
    const dated = await Promise.all(attachments.map(async (uri) => ({ uri, stat: await vscode.workspace.fs.stat(uri) })));
    dated.sort((left, right) => left.stat.mtime - right.stat.mtime || left.stat.ctime - right.stat.ctime);
    const protectedUri = keep?.toString();
    await Promise.all(dated
      .filter(({ uri }) => uri.toString() !== protectedUri)
      .slice(0, excess)
      .map(({ uri }) => vscode.workspace.fs.delete(uri)));
  }
}
