import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitHeadUri } from "../src/platform/vscode/gitChanges.js";

const mocks = vi.hoisted(() => {
  const repository = () => ({ state: { workingTreeChanges: [], indexChanges: [] } });
  const gitApi = {
    repositories: [repository()],
    getRepository: vi.fn(repository),
    toGitUri: vi.fn((uri: { fsPath: string }, ref: string) => ({ toString: () => `git:${uri.fsPath}?ref=${ref}` }))
  };
  return { gitApi, stat: vi.fn() };
});

vi.mock("vscode", () => ({
  Uri: { file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }) },
  extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => mocks.gitApi } }) },
  workspace: { fs: { stat: mocks.stat }, asRelativePath: (uri: { fsPath: string }) => uri.fsPath }
}));

beforeEach(() => {
  mocks.stat.mockReset();
  mocks.gitApi.getRepository.mockReset();
  mocks.gitApi.getRepository.mockImplementation(() => ({ state: { workingTreeChanges: [], indexChanges: [] } }));
});

describe("gitHeadUri", () => {
  it("returns the committed side of a tracked file", async () => {
    mocks.stat.mockResolvedValue({ type: 1 });
    expect(String(await gitHeadUri({ fsPath: "/repo/a.ts" } as never))).toBe("git:/repo/a.ts?ref=HEAD");
  });

  it("uses the empty tree for a file Git never committed", async () => {
    mocks.stat.mockRejectedValueOnce(new Error("FileNotFound"));
    expect(String(await gitHeadUri({ fsPath: "/repo/new.ts" } as never))).toBe(
      "git:/repo/new.ts?ref=4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    );
  });

  it("gives up outside a repository", async () => {
    mocks.gitApi.getRepository.mockReturnValueOnce(null as never);
    expect(await gitHeadUri({ fsPath: "/repo/a.ts" } as never)).toBeUndefined();
  });
});
