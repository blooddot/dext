import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { insideRealRoot, insideRoot } from "../src/platform/node/insideRoot.js";

const root = join(process.cwd(), "workspace");

describe("insideRoot", () => {
  it("accepts the root itself unless it is excluded", () => {
    expect(insideRoot(root, root)).toBe(true);
    expect(insideRoot(root, join(root, "."))).toBe(true);
    expect(insideRoot(root, root, { allowRoot: false })).toBe(false);
  });

  it("accepts paths below the root, including names that start with dots", () => {
    expect(insideRoot(root, join(root, "a", "b.ts"))).toBe(true);
    expect(insideRoot(root, join(root, "..cache", "build.md"))).toBe(true);
  });

  it("rejects escapes and absolute paths from another drive", () => {
    expect(insideRoot(root, join(root, "..", "x.ts"))).toBe(false);
    expect(insideRoot(root, "..")).toBe(false);
    expect(insideRoot(root, "D:/x.ts")).toBe(false);
  });
});

describe("insideRealRoot", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function aliasedWorkspace() {
    const directory = await mkdtemp(join(tmpdir(), "dext-inside-root-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    const alias = join(directory, "alias");
    await mkdir(workspace);
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    return { directory, workspace, alias };
  }

  it("accepts missing descendants beneath a symlinked workspace", async () => {
    const { workspace, alias } = await aliasedWorkspace();
    const candidate = join(alias, ".dext", "templates", "missing.md");
    expect(await insideRealRoot(workspace, candidate)).toBe(true);
    expect(await insideRealRoot(alias, candidate)).toBe(true);
    expect(await insideRealRoot(join(alias, ".dext", "templates"), candidate)).toBe(true);
  });

  it("compares aliases of a missing root consistently", async () => {
    const { workspace, alias } = await aliasedWorkspace();
    const missingRoot = join(workspace, ".dext", "rules");
    const aliasRoot = join(alias, ".dext", "rules");
    expect(await insideRealRoot(missingRoot, aliasRoot)).toBe(true);
    expect(await insideRealRoot(missingRoot, aliasRoot, { allowRoot: false })).toBe(false);
  });

  it("rejects missing descendants reached through a symlink outside the workspace", async () => {
    const { directory, workspace, alias } = await aliasedWorkspace();
    const outside = join(directory, "outside");
    await mkdir(outside);
    await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    expect(await insideRealRoot(alias, join(alias, "escape"))).toBe(false);
    expect(await insideRealRoot(alias, `${join(alias, "escape")}${sep}..`)).toBe(false);
    expect(await insideRealRoot(alias, join(alias, "escape", "nested", "missing.md"))).toBe(false);
    expect(await insideRealRoot(alias, join(alias, "..", "outside", "missing.md"))).toBe(false);
  });
});
