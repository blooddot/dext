import { beforeEach, describe, expect, it, vi } from "vitest";
import { changedWorkspaceFiles, dirtyBaseline, gitHeadUri } from "../src/platform/vscode/gitChanges.js";

/** One workspace folder at `/w`, one Git repository, and the files Git reports
 * as dirty. Only the members `gitChanges` reads are mocked. */
const mocks = vi.hoisted(() => ({
  files: new Map<string, { mtime: number; size: number }>(),
  dirty: [] as string[],
  gitInstalled: true,
  inRepository: true,
  headExists: true
}));

vi.mock("vscode", () => {
  const api = {
    get repositories() {
      return [{ state: { workingTreeChanges: mocks.dirty.map((fsPath) => ({ uri: { fsPath } })), indexChanges: [] } }];
    },
    getRepository: () => mocks.inRepository ? { state: { workingTreeChanges: [], indexChanges: [] } } : null,
    toGitUri: (uri: { fsPath: string }, ref: string) => ({
      fsPath: uri.fsPath,
      ref,
      toString: () => `git:${uri.fsPath}?ref=${ref}`
    })
  };
  return {
    Uri: { file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }) },
    workspace: {
      fs: {
        stat: async (uri: { fsPath: string; ref?: string }) => {
          // The `git:` side of a diff: served only while HEAD holds the file.
          if (uri.ref) {
            if (mocks.headExists) return { mtime: 0, size: 0 };
            throw new Error("FileNotFound");
          }
          const file = mocks.files.get(uri.fsPath);
          if (!file) throw new Error("FileNotFound");
          return { mtime: file.mtime, size: file.size };
        }
      },
      asRelativePath: (uri: { fsPath: string }) => uri.fsPath.slice("/w/".length),
      getWorkspaceFolder: (uri: { fsPath: string }) => uri.fsPath.startsWith("/w/") ? { uri: { fsPath: "/w" } } : undefined
    },
    extensions: {
      getExtension: () => mocks.gitInstalled ? { isActive: true, exports: { getAPI: () => api } } : undefined
    }
  };
});

beforeEach(() => {
  mocks.files.clear();
  mocks.dirty.length = 0;
  mocks.gitInstalled = true;
  mocks.inRepository = true;
  mocks.headExists = true;
});

describe("changedWorkspaceFiles", () => {
  it("takes the paths the agent reported, in workspace-relative form", async () => {
    // Git's own list would also name `src/other.ts`; the agent's report wins.
    mocks.files.set("/w/src/other.ts", { mtime: 99, size: 1 });
    mocks.dirty.push("/w/src/other.ts");
    expect(await changedWorkspaceFiles(0, ["src/a.ts", "/w/src/b.ts", "/elsewhere/c.ts", "../d.ts"]))
      .toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("falls back to the dirty files that moved since the turn started", async () => {
    mocks.files.set("/w/src/old.ts", { mtime: 10, size: 1 });
    mocks.files.set("/w/src/new.ts", { mtime: 90, size: 1 });
    mocks.dirty.push("/w/src/old.ts", "/w/src/new.ts");
    expect(await changedWorkspaceFiles(50)).toEqual(["src/new.ts"]);
  });

  it("leaves out a file that was already uncommitted and untouched when the turn started", async () => {
    mocks.files.set("/w/src/legacy.ts", { mtime: 10, size: 1 });
    mocks.files.set("/w/src/touched.ts", { mtime: 10, size: 1 });
    mocks.dirty.push("/w/src/legacy.ts", "/w/src/touched.ts");
    const baseline = await dirtyBaseline();
    mocks.files.set("/w/src/touched.ts", { mtime: 90, size: 2 });
    expect(await changedWorkspaceFiles(0, [], baseline)).toEqual(["src/touched.ts"]);
  });

  it("reports no list at all outside a Git repository", async () => {
    mocks.gitInstalled = false;
    expect(await changedWorkspaceFiles(0)).toBeUndefined();
  });
});

describe("gitHeadUri", () => {
  it("returns the committed side of a tracked file", async () => {
    expect(String(await gitHeadUri({ fsPath: "/repo/a.ts" } as never))).toBe("git:/repo/a.ts?ref=HEAD");
  });

  it("uses the empty tree for a file Git never committed", async () => {
    mocks.headExists = false;
    expect(String(await gitHeadUri({ fsPath: "/repo/new.ts" } as never))).toBe(
      "git:/repo/new.ts?ref=4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    );
  });

  it("gives up outside a repository", async () => {
    mocks.inRepository = false;
    expect(await gitHeadUri({ fsPath: "/repo/a.ts" } as never)).toBeUndefined();
  });
});
