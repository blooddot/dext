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

/** Paths a turn wrote, derived from what Git already reports as dirty. Absent
 * when the workspace is not in a Git repository, which is the signal that no
 * diff can be offered.
 * shortcut: modified time is the only per-file timestamp Git exposes, so a tool
 * that writes an older mtime hides that file. Upgrade to a status + content-hash
 * snapshot taken around the turn. */
export async function changedWorkspaceFiles(since: number): Promise<string[] | undefined> {
  const git = await gitApi();
  if (!git?.repositories.length) return undefined;
  const paths = new Set<string>();
  for (const repository of git.repositories) {
    for (const change of [...repository.state.workingTreeChanges, ...repository.state.indexChanges]) {
      let modified: number;
      try {
        modified = (await vscode.workspace.fs.stat(change.uri)).mtime;
      } catch {
        continue; // Deleted, or outside the workspace.
      }
      if (modified < since) continue;
      // Default returns `<folder>/<path>` only for a multi-root workspace, which
      // is the form `contextHost.workspaceFileUri` resolves back to a file.
      paths.add(vscode.workspace.asRelativePath(change.uri));
    }
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
