import * as vscode from "vscode";

/** The slice of the built-in Git extension API this feature needs, taken from
 * `extensions/git/src/api/git.d.ts`. Only the members used here are declared. */
interface GitChange {
  readonly uri: vscode.Uri;
}

interface GitRepository {
  readonly state: {
    readonly workingTreeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
  };
}

interface GitApi {
  readonly repositories: readonly GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

async function gitApi(): Promise<GitApi | undefined> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  if (!extension) return undefined;
  const api = extension.isActive ? extension.exports : await extension.activate();
  return api?.getAPI(1);
}

/** What one file looked like when a turn started. mtime alone is too coarse for
 * two writes in the same second, so the size comes along. */
interface FileStamp {
  mtime: number;
  key: string;
}

async function fileStamp(uri: vscode.Uri): Promise<FileStamp | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return { mtime: stat.mtime, key: `${stat.mtime}:${stat.size}` };
  } catch {
    return undefined; // Deleted, or outside the workspace.
  }
}

/** Every path Git reports as dirty, worktree and index. The paths are
 * workspace-relative — with the folder name only in a multi-root workspace,
 * the form `contextHost.workspaceFileUri` resolves back to a file. */
async function dirtyPaths(): Promise<{ path: string; uri: vscode.Uri }[] | undefined> {
  const git = await gitApi();
  if (!git?.repositories.length) return undefined;
  return git.repositories.flatMap((repository) =>
    [...repository.state.workingTreeChanges, ...repository.state.indexChanges]
      .map((change) => ({ path: vscode.workspace.asRelativePath(change.uri), uri: change.uri })));
}

/** What Git reported dirty when a turn started, keyed by path. A file that was
 * already uncommitted before the turn is only this turn's change if it moved. */
export type DirtyBaseline = ReadonlyMap<string, string>;

export async function dirtyBaseline(): Promise<DirtyBaseline> {
  const baseline = new Map<string, string>();
  for (const file of (await dirtyPaths()) ?? []) {
    const stamp = await fileStamp(file.uri);
    if (stamp) baseline.set(file.path, stamp.key);
  }
  return baseline;
}

/** A path as the agent named it, in the workspace-relative form the rest of
 * Dext resolves. Undefined for a file outside every workspace folder. */
function workspacePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (!/^[A-Za-z]:\//.test(normalized) && !normalized.startsWith("/")) {
    // Relative to the workspace root the agent ran in; `..` would leave it.
    const segments = normalized.split("/");
    return segments.some((segment) => !segment || segment === "." || segment === "..") ? undefined : normalized;
  }
  const uri = vscode.Uri.file(normalized);
  return vscode.workspace.getWorkspaceFolder(uri) ? vscode.workspace.asRelativePath(uri) : undefined;
}

/** Paths a turn wrote. What the agent reported writing wins: it is the only
 * source that names the turn's own files. Without it, Git's dirty files that
 * moved since `since` stand in. Absent when the workspace is not a Git
 * repository and the agent reported nothing, which is the signal that no diff
 * can be offered.
 * shortcut: the Git fallback compares mtime and size, so a file the turn
 * rewrote to the same bytes is missed, and one another process rewrote inside
 * the turn's window is counted. Providers that report writes never take it. */
export async function changedWorkspaceFiles(
  since: number,
  written: readonly string[] = [],
  baseline?: DirtyBaseline
): Promise<string[] | undefined> {
  const reported = [...new Set(written.flatMap((path) => workspacePath(path) ?? []))].sort();
  if (reported.length) return reported;
  const dirty = await dirtyPaths();
  if (!dirty) return undefined;
  const paths = new Set<string>();
  for (const file of dirty) {
    const stamp = await fileStamp(file.uri);
    if (!stamp || stamp.mtime < since || baseline?.get(file.path) === stamp.key) continue;
    paths.add(file.path);
  }
  return [...paths].sort();
}

/** Git's empty tree, which the `git:` file system serves as an empty file. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The `HEAD` side of a workspace file, or undefined outside a repository. A
 * file HEAD never committed gets the empty tree, so a new file opens as a
 * whole-file addition instead of a diff that cannot load.
 * shortcut: the constant is Git's sha1 empty tree, so a sha256 repository still
 * fails for new files. Upgrade to asking the Git extension for its empty tree. */
export async function gitHeadUri(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const git = await gitApi();
  if (!git?.getRepository(uri)) return undefined;
  const head = git.toGitUri(uri, "HEAD");
  try {
    await vscode.workspace.fs.stat(head);
    return head;
  } catch {
    return git.toGitUri(uri, EMPTY_TREE);
  }
}
