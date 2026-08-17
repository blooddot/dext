import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { SkillCatalog } from "../src/core/skillCatalog.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SkillCatalog", () => {
  it("discovers default directories in priority order and loads SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-skills-"));
    roots.push(root);
    await mkdir(join(root, ".agents", "skills", "dev-feat"), { recursive: true });
    await mkdir(join(root, "dext", "skills", "dev-feat"), { recursive: true });
    await writeFile(join(root, ".agents", "skills", "dev-feat", "SKILL.md"), "# Feature\nPrimary skill\n", "utf8");
    await writeFile(join(root, "dext", "skills", "dev-feat", "SKILL.md"), "# Shadow\nSecondary skill\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root);
    expect(catalog.list()).toMatchObject([{ id: "dev-feat", title: "Feature" }]);
    await expect(catalog.load("dev-feat", root)).resolves.toMatchObject({
      instructions: "# Feature\nPrimary skill\n",
      sourcePath: join(root, ".agents", "skills", "dev-feat", "SKILL.md")
    });
  });

  it("accepts configured additional directories after project defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "dext-skills-"));
    roots.push(root);
    await mkdir(join(root, "shared", "fix"), { recursive: true });
    await writeFile(join(root, "shared", "fix", "SKILL.md"), "name: Fix\ndescription: Repair a bug\n", "utf8");
    const catalog = new SkillCatalog();
    await catalog.reload(root, ["shared"]);
    expect(catalog.list()).toMatchObject([{ id: "fix", title: "Fix", description: "Repair a bug" }]);
  });
});
