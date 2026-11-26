import { mkdtemp, mkdir, realpath, rename, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { SkillCatalog } from "../src/features/workflow/host/skillCatalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Resolve the OS temp directory's symbolic links (macOS `/var` → `/private/var`)
// so assertions compare the catalog's canonical paths with the root's real path.
async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dext-skills-")));
  roots.push(root);
  return root;
}

function manifest(skills: Array<{ id: string; directory?: string }>, commands: Array<Record<string, unknown>> = []) {
  return {
    name: "ponytail",
    source: "https://github.com/DietrichGebert/ponytail",
    importedAt: "2026-10-26T00:00:00.000Z",
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.id,
      description: "Lean code",
      directory: skill.directory ?? `skills/${skill.id}`,
      commands: commands.filter((command) => command.skillId === skill.id).map((command) => command.id),
      warnings: []
    })),
    commands,
    analysis: {
      mode: "deterministic",
      selected: skills.map((skill) => skill.directory ?? `skills/${skill.id}`),
      excluded: [],
      skipped: []
    }
  };
}

describe("SkillCatalog", () => {
  it("discovers only the Dext-owned default directory and loads SKILL.md", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".dext", "skills", "dev-feat"), { recursive: true });
    await mkdir(join(root, ".agents", "skills", "ignored"), { recursive: true });
    await writeFile(join(root, ".dext", "skills", "dev-feat", "SKILL.md"), "# Feature\nPrimary skill\n", "utf8");
    await writeFile(join(root, ".agents", "skills", "ignored", "SKILL.md"), "# Ignored\nNot a Dext skill\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    expect(catalog.list()).toMatchObject([{ id: "dev-feat", title: "Feature" }]);
    await expect(catalog.load("dev-feat", root)).resolves.toMatchObject({
      instructions: "# Feature\nPrimary skill\n",
      sourcePath: join(root, ".dext", "skills", "dev-feat", "SKILL.md")
    });
    expect(catalog.list().map((skill) => skill.id)).toEqual(["dev-feat"]);
    await expect(catalog.describeForConversation("dev-feat", root, "codex")).resolves.toMatchObject({
      title: "Feature", description: "No description provided.", path: ".dext/skills/dev-feat/SKILL.md", changed: false
    });
  });

  it("accepts configured additional directories after project defaults", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "shared", "fix"), { recursive: true });
    await writeFile(join(root, "shared", "fix", "SKILL.md"), "name: Fix\ndescription: Repair a bug\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root, ["shared"]);
    expect(catalog.list()).toMatchObject([{ id: "fix", title: "Fix", description: "Repair a bug" }]);
    await expect(catalog.describeForConversation("fix", root, "codex")).resolves.toMatchObject({
      title: "Fix", description: "Repair a bug", path: "shared/fix/SKILL.md"
    });
  });

  it.each(["```yaml\ndescription: Configuration example\n```", "    description: Configuration example"])(
    "keeps a code example's description out of the conversation manifest",
    async (example) => {
      const root = await tempRoot();
      const skill = join(root, ".dext", "skills", "example");
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), example);
      const catalog = new SkillCatalog();
      await catalog.reload(root);
      expect(catalog.list()).toMatchObject([{ id: "example", description: "Configuration example" }]);
      await expect(catalog.describeForConversation("example", root, "codex")).resolves.toMatchObject({
        description: "No description provided."
      });
    }
  );

  it.each([
    ["```yaml\nname: Example value\n```\n# Real title\n", "Real title"],
    ["Intro\n\nname: Example value\n", "example"],
    ["~~~md\n# Example title\n~~~\n", "example"],
    ["    name: Example value\n    # Example title\n", "example"],
    ["#\n\n# Real title\n", "Real title"],
    ["---\nname: Declared name\n---\n# Other title\n", "Declared name"],
    ["\nname: 'Legacy name'\ndescription: Legacy description\n# Other title\n", "Legacy name"]
  ])("uses a declared Skill title for %j in the conversation manifest", async (source, title) => {
    const root = await tempRoot();
    const skill = join(root, ".dext", "skills", "example");
    const file = join(skill, "SKILL.md");
    await mkdir(skill, { recursive: true });
    await writeFile(file, "# Initial title\n");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    await writeFile(file, source);
    await expect(catalog.describeForConversation("example", root, "codex")).resolves.toMatchObject({ title, changed: true });
    await catalog.reload(root);
    await expect(catalog.describeForConversation("example", root, "codex")).resolves.toMatchObject({ title, changed: false });
  });

  it("reads pack manifests and maps installed commands to their skills", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".dext", "skills", "ponytail-review"), { recursive: true });
    await writeFile(join(root, ".dext", "skills", "ponytail-review", "SKILL.md"), "---\nname: Review\ndescription: >\n  Review a change\n  before shipping.\n---\n# Review\n", "utf8");
    await mkdir(join(root, ".dext", "skill-packs", "ponytail", "commands"), { recursive: true });
    await writeFile(join(root, ".dext", "skill-packs", "ponytail", "pack.json"), JSON.stringify(manifest(
      [{ id: "ponytail-review" }],
      [{
        id: "ponytail-review", title: "Review", description: "Review a change",
        skillId: "ponytail-review", source: ".opencode/command/review.md",
        file: "skill-packs/ponytail/commands/ponytail-review.md", status: "available"
      }]
    )), "utf8");
    await writeFile(join(root, ".dext", "skill-packs", "ponytail", "commands", "ponytail-review.md"), [
      "---",
      "description: Review a change",
      "argument-hint: <paths>",
      "---",
      "",
      "Review $ARGUMENTS."
    ].join("\n"), "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    expect(catalog.list()).toMatchObject([{
      id: "ponytail-review",
      title: "Review",
      description: "Review a change before shipping.",
      packId: "ponytail",
      packName: "ponytail",
      commandIds: ["ponytail-review"]
    }]);
    expect(catalog.commands()).toMatchObject([{
      id: "ponytail-review", skillId: "ponytail-review", syntax: "/ponytail-review", argumentHint: "<paths>"
    }]);
    const resolved = catalog.resolveCommand("ponytail-review", ["ponytail-review"], "src/a.ts");
    expect(resolved.status).toBe("ok");
    if (resolved.status === "ok") {
      expect(resolved.command.instruction).toBe("Review src/a.ts.");
      expect(resolved.command.template).toBe("Review $ARGUMENTS.");
    }
    expect(catalog.resolveCommand("ponytail-review", [])).toMatchObject({ status: "inactive" });
    expect(catalog.resolveCommand("missing", ["ponytail-review"])).toMatchObject({ status: "unknown" });
  });

  it("finds a vendored library that writes its own nested layout", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".dext", "third-party", "openspec", ".agents", "skills", "openspec-propose"), { recursive: true });
    await writeFile(join(root, ".dext", "third-party", "openspec", ".agents", "skills", "openspec-propose", "SKILL.md"), "# Propose\nDraft a change proposal\n", "utf8");
    await mkdir(join(root, ".dext", "third-party", "openspec", "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, ".dext", "third-party", "openspec", "node_modules", "pkg", "SKILL.md"), "# Dependency\nNot a vendor skill\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    expect(catalog.list()).toMatchObject([{ id: "openspec-propose", title: "Propose" }]);
    await expect(catalog.load("openspec-propose", root)).resolves.toMatchObject({
      sourcePath: join(root, ".dext", "third-party", "openspec", ".agents", "skills", "openspec-propose", "SKILL.md")
    });
  });

  it("keeps .dext/skills over a vendored duplicate id and reports it", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".dext", "skills", "propose"), { recursive: true });
    await mkdir(join(root, ".dext", "third-party", "lib", "skills", "propose"), { recursive: true });
    await writeFile(join(root, ".dext", "skills", "propose", "SKILL.md"), "# Local\n", "utf8");
    await writeFile(join(root, ".dext", "third-party", "lib", "skills", "propose", "SKILL.md"), "# Vendored\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    expect(catalog.list()).toMatchObject([{ id: "propose", title: "Local" }]);
    expect(catalog.warnings().join(" ")).toMatch(/propose: also defined at/);
  });

  it("reads a nested skill's own commands directory", async () => {
    const root = await tempRoot();
    const skill = join(root, ".dext", "third-party", "lib", "skills", "shipper");
    await mkdir(join(skill, "commands"), { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# Shipper\n", "utf8");
    await writeFile(join(skill, "commands", "ship.md"), "---\nskill: shipper\n---\n\n# Ship\n\nShip $ARGUMENTS.\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    expect(catalog.commands()).toMatchObject([{ id: "ship", skillId: "shipper" }]);
    expect(catalog.resolveCommand("ship", ["shipper"], "now")).toMatchObject({ status: "ok" });
  });

  it("reports unsupported and missing command files as invalid", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".dext", "skills", "review"), { recursive: true });
    await writeFile(join(root, ".dext", "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await mkdir(join(root, ".dext", "skill-packs", "pack", "commands"), { recursive: true });
    await writeFile(join(root, ".dext", "skill-packs", "pack", "pack.json"), JSON.stringify(manifest(
      [{ id: "review" }],
      [
        { id: "positional", title: "Positional", description: "", skillId: "review", file: "skill-packs/pack/commands/positional.md", status: "available" },
        { id: "missing", title: "Missing", description: "", skillId: "review", file: "skill-packs/pack/commands/missing.md", status: "available" }
      ]
    )), "utf8");
    await writeFile(join(root, ".dext", "skill-packs", "pack", "commands", "positional.md"), "Review $1.", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    expect(catalog.commands()).toEqual([]);
    expect(catalog.resolveCommand("positional", ["review"])).toMatchObject({ status: "invalid" });
    expect(catalog.resolveCommand("missing", ["review"])).toMatchObject({ status: "invalid" });
  });

  it("tolerates a malformed manifest and keeps discovering skills", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".dext", "skills", "kept"), { recursive: true });
    await writeFile(join(root, ".dext", "skills", "kept", "SKILL.md"), "# Kept\n", "utf8");
    await mkdir(join(root, ".dext", "skill-packs", "broken"), { recursive: true });
    await writeFile(join(root, ".dext", "skill-packs", "broken", "pack.json"), "{not json", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    expect(catalog.list().map((skill) => skill.id)).toEqual(["kept"]);
    expect(catalog.warnings().join(" ")).toMatch(/malformed pack manifest/);
  });

  it("keeps local skills over a global root with the same id", async () => {
    const root = await tempRoot();
    const global = await tempRoot();
    await mkdir(join(root, ".dext", "skills", "same"), { recursive: true });
    await mkdir(join(global, "same"), { recursive: true });
    await writeFile(join(root, ".dext", "skills", "same", "SKILL.md"), "# Local\n", "utf8");
    await writeFile(join(global, "same", "SKILL.md"), "# Global\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root, [], global);
    expect(catalog.list()).toMatchObject([{ id: "same", title: "Local" }]);
    await expect(catalog.load("same", root)).resolves.toMatchObject({ sourcePath: join(root, ".dext", "skills", "same", "SKILL.md") });
    await expect(catalog.describeForConversation("same", root, "codex")).resolves.toMatchObject({
      title: "Local", path: ".dext/skills/same/SKILL.md"
    });
    await rm(join(root, ".dext", "skills", "same", "SKILL.md"));
    await expect(catalog.describeForConversation("same", root, "codex")).rejects.toThrow(/ENOENT/);
    await catalog.reload(root, [], global);
    await expect(catalog.describeForConversation("same", root, "codex")).resolves.toMatchObject({
      title: "Global", path: join(global, "same", "SKILL.md")
    });
  });

  it("rejects a linked replacement in a sibling with the same root prefix", async () => {
    const root = await tempRoot();
    const skills = join(root, ".dext", "skills");
    const original = join(skills, "review");
    const outside = join(root, ".dext", "skills-external", "review");
    await mkdir(original, { recursive: true });
    await writeFile(join(original, "SKILL.md"), "# Review");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    await mkdir(join(root, ".dext", "skills-external"));
    await rename(original, outside);
    await symlink(outside, original, "junction");
    await expect(catalog.describeForConversation("review", root, "codex")).rejects.toThrow("outside its registered root");
  });

  it("refreshes edited metadata and keeps a stable revision after the first lookup", async () => {
    const root = await tempRoot();
    const directory = join(root, ".dext", "skills", "review");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "SKILL.md");
    await writeFile(path, "---\nname: Old\ndescription: Before\n---\nOld body");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    const before = await catalog.describeForConversation("review", root, "codex");
    const newDescription = "x".repeat(320);
    await writeFile(path, `---\nname: Updated\ndescription: |\n  First line\n  ${newDescription}\n---\nNEW_BODY`);
    const after = await catalog.describeForConversation("review", root, "codex");
    expect(after).toMatchObject({ title: "Updated", changed: true });
    expect(after.description).toHaveLength(300);
    expect(after.description).toMatch(/^First line x+…$/);
    expect(after.revision).not.toBe(before.revision);
    await expect(catalog.describeForConversation("review", root, "codex")).resolves.toEqual({ ...after, changed: false });
    await catalog.reload(root);
    await expect(catalog.describeForConversation("review", root, "codex")).resolves.toEqual({ ...after, changed: false });
  });

  it("changes the revision for same-size body edits and keeps it stable when only timestamps change", async () => {
    const root = await tempRoot();
    const directory = join(root, ".dext", "skills", "review");
    const path = join(directory, "SKILL.md");
    await mkdir(directory, { recursive: true });
    await writeFile(path, "# Review\nBefore\n");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    const before = await catalog.describeForConversation("review", root, "codex");

    const timestamp = new Date("2020-01-01T00:00:00Z");
    await utimes(path, timestamp, timestamp);
    await expect(catalog.describeForConversation("review", root, "codex")).resolves.toEqual(before);

    await writeFile(path, "# Review\nAfter!\n");
    await utimes(path, timestamp, timestamp);
    const after = await catalog.describeForConversation("review", root, "codex");
    expect(after).toMatchObject({ title: before.title, changed: true });
    expect(after.revision).not.toBe(before.revision);
    await expect(catalog.describeForConversation("review", root, "codex")).resolves.toEqual({ ...after, changed: false });
  });

  it("keeps local commands over a global pack's command with the same id", async () => {
    const root = await tempRoot();
    const global = await tempRoot();
    await mkdir(join(root, ".dext", "skills", "same", "commands"), { recursive: true });
    await writeFile(join(root, ".dext", "skills", "same", "SKILL.md"), "# Same\n", "utf8");
    await writeFile(join(root, ".dext", "skills", "same", "commands", "hello.md"), "---\nskill: same\n---\n\n# Local hello\n\nLocal $ARGUMENTS.\n", "utf8");
    await mkdir(join(global, "same"), { recursive: true });
    await writeFile(join(global, "same", "SKILL.md"), "# Global same\n", "utf8");
    await mkdir(join(global, "skill-packs", "pack", "commands"), { recursive: true });
    await writeFile(join(global, "skill-packs", "pack", "pack.json"), JSON.stringify(manifest(
      [{ id: "same" }],
      [{
        id: "hello", title: "Global hello", description: "", skillId: "same",
        file: "skill-packs/pack/commands/hello.md", status: "available"
      }]
    )), "utf8");
    await writeFile(join(global, "skill-packs", "pack", "commands", "hello.md"), "# Global hello\n\nGlobal $ARGUMENTS.\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root, [], global);
    // The global pack must not claim the locally shadowed skill.
    expect(catalog.list()).toMatchObject([{ id: "same", title: "Same", commandIds: ["hello"] }]);
    expect(catalog.list()[0]!.packId).toBeUndefined();
    const resolved = catalog.resolveCommand("hello", ["same"], "now");
    expect(resolved).toMatchObject({ status: "ok", command: { title: "Local hello" } });
    if (resolved.status === "ok") {
      expect(resolved.command.instruction).toContain("Local now.");
      expect(resolved.command.instruction).not.toContain("Global");
    }
  });
});
