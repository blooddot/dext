import { describe, expect, it } from "vitest";
import type { ResourceDocument } from "../src/features/resources/contracts/resourceSession.js";
import type { SkillPackManifest } from "../src/features/resources/domain/skillPack.js";
import { buildSkillPackUpgradePlan, compareSkillPackContent } from "../src/features/resources/domain/skillPackUpgrade.js";

function manifest(skills: string[], commit = "old"): SkillPackManifest {
  return {
    name: "demo",
    version: 2,
    source: "https://github.com/acme/demo",
    commit,
    importedAt: "2026-10-26T00:00:00.000Z",
    skills: skills.map((id) => ({
      id,
      name: id,
      description: id,
      directory: `skills/${id}`,
      agent: "shared",
      file: `skills/${id}/SKILL.md`,
      commands: [],
      warnings: []
    })),
    commands: [],
    analysis: { mode: "deterministic", selected: [], excluded: [], skipped: [] }
  };
}

function draft(paths: string[]): ResourceDocument {
  return {
    name: "alpha",
    content: "# Alpha v2",
    files: paths.map((path) => ({ path, content: `content of ${path}` }))
  };
}

describe("skill pack upgrade plan", () => {
  it("replaces the old tree and lists added and removed Skills", async () => {
    const plan = await buildSkillPackUpgradePlan({
      packId: "demo",
      existing: manifest(["alpha", "beta"]),
      draft: draft([
        "skills/alpha/reference.md",
        "skills/gamma/reference.md",
        "skills/gamma/SKILL.md",
        "skill-packs/demo/pack.json",
        "skill-packs/demo/SOURCE.md"
      ]),
      otherPacks: [],
      exists: async () => false
    });
    expect(plan.removeSkills).toEqual(["alpha", "beta"]);
    expect(plan.addedSkills).toEqual(["gamma"]);
    expect(plan.removedSkills).toEqual(["beta"]);
    expect(plan.files.find((file) => file.path === "skills/alpha/SKILL.md")?.content).toBe("# Alpha v2\n");
    expect(plan.files.map((file) => file.path)).toContain("skills/alpha/reference.md");
  });

  it("refuses a new Skill that already exists outside the pack", async () => {
    await expect(buildSkillPackUpgradePlan({
      packId: "demo",
      existing: manifest(["alpha"]),
      draft: draft(["skills/gamma/SKILL.md"]),
      otherPacks: [],
      exists: async (path) => path === "skills/gamma"
    })).rejects.toThrow("already exists outside this pack");
  });

  it("refuses a Skill claimed by another pack", async () => {
    await expect(buildSkillPackUpgradePlan({
      packId: "demo",
      existing: manifest(["alpha"]),
      draft: draft(["skills/gamma/SKILL.md"]),
      otherPacks: [{ id: "other", manifest: manifest(["gamma"], "other") }],
      exists: async () => false
    })).rejects.toThrow("also claimed by another installed pack");
  });

  it("refuses an unsafe Skill id in the installed manifest", async () => {
    await expect(buildSkillPackUpgradePlan({
      packId: "demo",
      existing: manifest(["../escape"]),
      draft: draft([]),
      otherPacks: [],
      exists: async () => false
    })).rejects.toThrow("unsafe Skill id");
  });

  it("refuses to write outside the pack's own directories", async () => {
    await expect(buildSkillPackUpgradePlan({
      packId: "demo",
      existing: manifest(["alpha"]),
      draft: { name: "alpha", content: "# Alpha", files: [{ path: "rules/review.md", content: "x" }] },
      otherPacks: [],
      exists: async () => false
    })).rejects.toThrow("outside its own directories");
  });

  it("refuses a second primary Skill.md for the same Skill", async () => {
    await expect(buildSkillPackUpgradePlan({
      packId: "demo",
      existing: manifest(["alpha"]),
      draft: draft(["skills/alpha/SKILL.md"]),
      otherPacks: [],
      exists: async () => false
    })).rejects.toThrow("writes 'skills/alpha/SKILL.md' twice");
  });
});

describe("skill pack content comparison", () => {
  const encoder = new TextEncoder();

  it("ignores generated metadata and line-ending differences", () => {
    const installed = new Map([
      ["skills/alpha/SKILL.md", encoder.encode("# Alpha\r\n")],
      ["skill-packs/demo/pack.json", encoder.encode('{"commit":"old"}')],
      ["skill-packs/demo/SOURCE.md", encoder.encode("# Demo old")]
    ]);
    const diff = compareSkillPackContent({
      packId: "demo",
      planFiles: [
        { path: "skills/alpha/SKILL.md", content: "# Alpha\n" },
        { path: "skill-packs/demo/pack.json", content: '{"commit":"new"}' },
        { path: "skill-packs/demo/SOURCE.md", content: "# Demo new" }
      ],
      installed
    });
    expect(diff).toEqual({ identical: true, changed: [], added: [], removed: [] });
  });

  it("reports changed, added, and removed files", () => {
    const installed = new Map([
      ["skills/alpha/SKILL.md", encoder.encode("# Alpha v1\n")],
      ["skills/alpha/extra.md", encoder.encode("stale\n")],
      ["skills/beta/SKILL.md", encoder.encode("# Beta\n")]
    ]);
    const diff = compareSkillPackContent({
      packId: "demo",
      planFiles: [
        { path: "skills/alpha/SKILL.md", content: "# Alpha v2\n" },
        { path: "skills/gamma/SKILL.md", content: "# Gamma\n" }
      ],
      installed
    });
    expect(diff.identical).toBe(false);
    expect(diff.changed).toEqual(["skills/alpha/SKILL.md"]);
    expect(diff.added).toEqual(["skills/gamma/SKILL.md"]);
    expect(diff.removed).toEqual(["skills/alpha/extra.md", "skills/beta/SKILL.md"]);
  });
});
