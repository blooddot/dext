import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { SkillCatalog } from "../src/features/workflow/host/skillCatalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dext-skills-"));
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
  });

  it("accepts configured additional directories after project defaults", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "shared", "fix"), { recursive: true });
    await writeFile(join(root, "shared", "fix", "SKILL.md"), "name: Fix\ndescription: Repair a bug\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root, ["shared"]);
    expect(catalog.list()).toMatchObject([{ id: "fix", title: "Fix", description: "Repair a bug" }]);
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
