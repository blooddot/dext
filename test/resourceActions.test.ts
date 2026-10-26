import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceEntry } from "../src/features/resources/contracts/resourceDocuments.js";
import { RESOURCE_DIRECTORIES } from "../src/features/resources/contracts/resourceSession.js";
import { managedResourcePath, removeManagedResource, resourceRemovalPlan, type ResourceRemovalPlan } from "../src/features/resources/host/resourceActions.js";
import { importSkillPack } from "../src/features/resources/host/skillImporter.js";
import { SkillCatalog } from "../src/features/workflow/host/skillCatalog.js";

let workspace: string;
let root: string;
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "dext-resource-actions-")); root = join(workspace, ".dext"); });
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

function entry(kind: ResourceEntry["kind"], path: string, scope: ResourceEntry["scope"] = "project"): ResourceEntry {
  return { id: `${kind}:${scope}:${path}`, kind, path, scope, name: path, group: ".",
    source: { kind: scope, label: scope, path: join(root, RESOURCE_DIRECTORIES[kind], path) } };
}
async function put(path: string, content = "source"): Promise<void> {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}
function pack(id: string, skills: Array<{ id: string; file?: string; agent?: string }>, version = 1) {
  return put(`skill-packs/${id}/pack.json`, JSON.stringify({ name: id, version, skills }));
}
function host() {
  return {
    confirm: vi.fn<(plan: ResourceRemovalPlan) => Promise<boolean>>().mockResolvedValue(true),
    dirtyPaths: vi.fn((): string[] => []),
    trash: vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  };
}

describe("managed resource actions", () => {
  it.each(["project", "global"] as const)("resolves %s files from their managed root and rejects forged or read-only sources", (scope) => {
    const source = entry("rule", "team/style.md", scope);
    expect(managedResourcePath(source, root)).toBe(resolve(root, "rules/team/style.md"));
    expect(() => managedResourcePath({ ...source, source: { ...source.source, path: join(workspace, "outside.md") } }, root)).toThrow("outside");
    expect(() => managedResourcePath({ ...source, path: "../outside.md" }, root)).toThrow("Invalid resource path");
    expect(() => managedResourcePath({ ...source, source: { kind: "directory", label: "builtin" } }, root)).toThrow("read-only");
    expect(() => managedResourcePath(entry("file", "README.md", scope), root)).toThrow("read-only");
  });

  it.each(["api", "mcp", "rule"] as const)("deletes only the selected %s file", async (kind) => {
    const path = { api: "team/run.ts", mcp: "team/server.jsonc", rule: "team/style.md" }[kind];
    const source = entry(kind, path);
    const removal = host();
    expect(await removeManagedResource(source, root, removal)).toBe(true);
    expect(removal.trash.mock.calls.map(([path]) => path)).toEqual([source.source.path]);
  });

  it("removes a standalone nested Skill's directory including companions", async () => {
    const removal = host();
    await removeManagedResource(entry("skill", "team/release/SKILL.md"), root, removal);
    expect(removal.trash).toHaveBeenCalledExactlyOnceWith(join(root, "skills/team/release"));
  });

  it("uninstalls an imported pack's variants, commands and manifest, preserving other resources", async () => {
    const instructions = (name: string, body: string) => `---\nname: ${name}\ndescription: Work on ${name}.\n---\n${body}\n`;
    const imported = await importSkillPack("https://github.com/acme/pack", { archive: {
      source: { kind: "repo", owner: "acme", repo: "pack", path: "", repositoryUrl: "https://github.com/acme/pack" },
      ref: "main", commit: "abc1234", files: new Map(Object.entries({
        "skills/review/SKILL.md": instructions("review", "Shared review"),
        ".codex/skills/review/SKILL.md": instructions("review", "Codex review"),
        "skills/deploy/SKILL.md": instructions("deploy", "Shared deploy"),
        ".claude/commands/review.md": "---\nskill: review\n---\nReview changes.\n"
      }).map(([path, content]) => [path, new TextEncoder().encode(content)]))
    } });
    for (const file of [{ path: `skills/${imported.draft.name}/SKILL.md`, content: imported.draft.content }, ...imported.draft.files ?? []]) {
      await put(file.path, file.content);
    }
    await put("skills/unrelated/SKILL.md", instructions("unrelated", "Keep this"));
    const catalog = new SkillCatalog();
    await catalog.reload(workspace);
    expect(catalog.list("codex").map(skill => skill.id).sort()).toEqual(["deploy", "review", "unrelated"]);
    expect(catalog.commands("claude")).toHaveLength(1);
    const removal = host();
    const trashRoot = join(workspace, "trash");
    await mkdir(trashRoot);
    removal.trash.mockImplementation(async (path) => {
      // Only fixture-owned paths can be moved; the Trash lives outside the resource root.
      expect(relative(root, path)).not.toMatch(/^\.\./);
      await rename(path, join(trashRoot, String(removal.trash.mock.calls.length)));
    });
    await removeManagedResource(entry("skill", "review/SKILL.md"), root, removal);
    expect(removal.confirm.mock.calls[0]?.[0]).toMatchObject({ label: "Skill pack 'pack'", skills: ["review", "deploy"] });
    expect(removal.trash.mock.calls.map(([path]) => relative(root, path).replaceAll("\\", "/"))).toEqual(["skills/review", "skills/deploy", "skill-packs/pack"]);
    await catalog.reload(workspace);
    expect(catalog.list("codex").map(skill => skill.id)).toEqual(["unrelated"]);
    expect(catalog.commands("claude")).toEqual([]);
    // Every path from the original draft is available for a fresh import.
    await expect(readFile(join(root, "skill-packs/pack/pack.json"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const file of [{ path: `skills/${imported.draft.name}/SKILL.md`, content: imported.draft.content }, ...imported.draft.files ?? []]) await put(file.path, file.content);
    await catalog.reload(workspace);
    expect(catalog.list("codex").map(skill => skill.id).sort()).toEqual(["deploy", "review", "unrelated"]);
  });

  it("uninstalls legacy packs using their canonical Skill directories", async () => {
    await pack("legacy", [{ id: "review" }, { id: "deploy" }]);
    expect(await resourceRemovalPlan(entry("skill", "review/SKILL.md"), root)).toMatchObject({
      label: "Skill pack 'legacy'", targets: [join(root, "skills/review"), join(root, "skills/deploy"), join(root, "skill-packs/legacy")]
    });
  });

  it("does nothing when the user cancels", async () => {
    const removal = host(); removal.confirm.mockResolvedValue(false);
    expect(await removeManagedResource(entry("skill", "review/SKILL.md"), root, removal)).toBe(false);
    expect(removal.trash).not.toHaveBeenCalled();
  });

  it.each([false, true])("protects unsaved companion files (becomes dirty during confirmation: %s)", async (duringConfirmation) => {
    const removal = host();
    const dirty = () => [join(root, "skills/review/reference.md")];
    if (duringConfirmation) removal.confirm.mockImplementation(async () => { removal.dirtyPaths.mockImplementation(dirty); return true; });
    else removal.dirtyPaths.mockImplementation(dirty);
    await expect(removeManagedResource(entry("skill", "review/SKILL.md"), root, removal)).rejects.toThrow("unsaved files");
    expect(removal.trash).not.toHaveBeenCalled();
    expect(removal.confirm).toHaveBeenCalledTimes(duringConfirmation ? 1 : 0);
  });

  it("rechecks pack ownership after confirmation", async () => {
    await pack("pack", [{ id: "review" }]);
    const removal = host();
    removal.confirm.mockImplementation(async () => { await pack("pack", [{ id: "review" }, { id: "deploy" }]); return true; });
    await expect(removeManagedResource(entry("skill", "review/SKILL.md"), root, removal)).rejects.toThrow("changed while confirming");
    expect(removal.trash).not.toHaveBeenCalled();
  });

  it("rejects overlapping pack ownership", async () => {
    await pack("first", [{ id: "review" }, { id: "deploy" }]);
    await pack("second", [{ id: "deploy" }]);
    await expect(resourceRemovalPlan(entry("skill", "review/SKILL.md"), root)).rejects.toThrow("Another pack also owns");
    await expect(resourceRemovalPlan(entry("skill", "deploy/SKILL.md"), root)).rejects.toThrow("more than one pack");
  });

  it.skipIf(process.platform !== "win32")("detects conflicting ownership even when a manifest uses different path casing", async () => {
    await pack("first", [{ id: "review" }]);
    await pack("second", [{ id: "Review" }]);
    await expect(resourceRemovalPlan(entry("skill", "review/SKILL.md"), root)).rejects.toThrow("more than one pack");
  });

  it.each(["../outside", "safe"])("rejects unsafe manifest paths and ids (%s)", async (id) => {
    await pack("pack", [{ id: "review" }, { id, file: "rules/outside.md" }], 2);
    await expect(resourceRemovalPlan(entry("skill", "review/SKILL.md"), root)).rejects.toThrow(id === "safe" ? "outside its owned directories" : "unsafe Skill id");
  });

  it("rejects a broken manifest before treating its Skills as standalone", async () => {
    await put("skill-packs/broken/pack.json", "{");
    await expect(resourceRemovalPlan(entry("skill", "review/SKILL.md"), root)).rejects.toThrow("invalid manifest");
  });

  it("rejects a linked directory before recursive removal", async () => {
    const outside = join(workspace, "outside");
    await mkdir(outside);
    await mkdir(join(root, "skills"), { recursive: true });
    await symlink(outside, join(root, "skills/review"), process.platform === "win32" ? "junction" : "dir");
    const removal = host();
    await expect(removeManagedResource(entry("skill", "review/SKILL.md"), root, removal)).rejects.toThrow("cannot follow a link");
    expect(removal.confirm).not.toHaveBeenCalled();
    expect(removal.trash).not.toHaveBeenCalled();
  });

  it("reports partial Trash failures and retains the manifest for retry", async () => {
    await pack("pack", [{ id: "review" }, { id: "deploy" }]);
    const removal = host();
    removal.trash.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Trash unavailable"));
    await expect(removeManagedResource(entry("skill", "review/SKILL.md"), root, removal)).rejects.toThrow(/Trash unavailable.*Already moved to Trash/);
    expect(removal.trash).toHaveBeenCalledTimes(2);
    await expect(readFile(join(root, "skill-packs/pack/pack.json"), "utf8")).resolves.toContain("review");
  });
});
