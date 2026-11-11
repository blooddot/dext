import { beforeEach, describe, expect, it, vi } from "vitest";
import { TurnSnapshots } from "../src/platform/vscode/turnSnapshots.js";

/** In-memory stand-in for `vscode.workspace.fs`: files hold text, directories
 * hold the modification time pruning sorts by. Keys are slash-normalised so the
 * assertions do not depend on the platform separator. */
const mocks = vi.hoisted(() => {
  const slash = (path: string): string => path.replaceAll("\\", "/");
  const files = new Map<string, string>();
  const dirs = new Map<string, number>();
  const parents = (path: string): string[] => {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  };
  const fs = {
    readFile: async (uri: { fsPath: string }) => {
      const content = files.get(slash(uri.fsPath));
      if (content === undefined) throw new Error("FileNotFound");
      return new TextEncoder().encode(content);
    },
    writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
      const path = slash(uri.fsPath);
      for (const dir of parents(path)) if (!dirs.has(dir)) dirs.set(dir, 0);
      files.set(path, new TextDecoder().decode(content));
    },
    createDirectory: async (uri: { fsPath: string }) => {
      dirs.set(slash(uri.fsPath), 0);
    },
    stat: async (uri: { fsPath: string }) => {
      const path = slash(uri.fsPath);
      if (files.has(path)) return { mtime: 0, type: 1 };
      const mtime = dirs.get(path);
      if (mtime === undefined) throw new Error("FileNotFound");
      return { mtime, type: 2 };
    },
    readDirectory: async (uri: { fsPath: string }) => {
      const prefix = `${slash(uri.fsPath)}/`;
      return [...dirs.keys(), ...files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => [path.slice(prefix.length), 2] as [string, number]);
    },
    delete: async (uri: { fsPath: string }) => {
      const path = slash(uri.fsPath);
      for (const key of [...dirs.keys()]) if (key === path || key.startsWith(`${path}/`)) dirs.delete(key);
      for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
    }
  };
  return { files, dirs, fs, slash };
});

vi.mock("vscode", () => ({
  FileType: { File: 1, Directory: 2 },
  Uri: {
    file: (fsPath: string) => ({ fsPath }),
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({ fsPath: [base.fsPath, ...segments].join("/") })
  },
  workspace: { fs: mocks.fs, workspaceFolders: [{ uri: { fsPath: "/w" } }] }
}));

const storage = { fsPath: "/s" };
const snapshot = (...parts: string[]) => ["/s", "turn-changes", ...parts].join("/");
const workspaceFile = (...parts: string[]) => ["/w", ...parts].join("/");

beforeEach(() => {
  mocks.files.clear();
  mocks.dirs.clear();
  mocks.files.set(workspaceFile("src", "a.ts"), "one");
  mocks.files.set(workspaceFile("src", "b.ts"), "two");
});

describe("TurnSnapshots", () => {
  it("copies the files a turn changed and finds them again", async () => {
    const snapshots = new TurnSnapshots(storage as never);
    await snapshots.save("s1", "t1", ["src/a.ts"]);
    expect(mocks.files.get(snapshot("s1", "t1", "src", "a.ts"))).toBe("one");
    expect(mocks.slash((await snapshots.find("s1", "t1", "src/a.ts"))!.fsPath)).toBe(snapshot("s1", "t1", "src", "a.ts"));
    expect(await snapshots.find("s1", "t1", "src/b.ts")).toBeUndefined();
    expect(await snapshots.find("s1", "t2", "src/a.ts")).toBeUndefined();
  });

  it("skips a path it cannot read instead of failing the turn", async () => {
    const snapshots = new TurnSnapshots(storage as never);
    await snapshots.save("s1", "t1", ["src/missing.ts", "src/a.ts"]);
    expect(await snapshots.find("s1", "t1", "src/missing.ts")).toBeUndefined();
    expect(await snapshots.find("s1", "t1", "src/a.ts")).toBeDefined();
  });

  it("keeps the newest 100 turns per conversation", async () => {
    const snapshots = new TurnSnapshots(storage as never);
    for (let index = 0; index < 101; index++) mocks.dirs.set(snapshot("s1", `t${index}`), index);
    await snapshots.save("s1", "t-new", ["src/a.ts"]);
    expect(mocks.dirs.has(snapshot("s1", "t0"))).toBe(false);
    expect(mocks.dirs.has(snapshot("s1", "t1"))).toBe(true);
    expect(mocks.dirs.has(snapshot("s1", "t100"))).toBe(true);
  });
});
