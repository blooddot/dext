import { describe, expect, it, vi } from "vitest";
import type { GithubSource } from "../src/features/resources/domain/skillSource.js";
import type { FetchedArchive } from "../src/features/resources/host/githubArchive.js";
import { importSkillPack, preflightSkillPack, SKILL_FILE_MAX_BYTES, SKILL_PACK_MAX_FILES, SKILL_PACK_MAX_BYTES, SKILL_SUPPORT_FILE_MAX_BYTES } from "../src/features/resources/host/skillImporter.js";
import type { SkillImportAnalysisRequest } from "../src/features/resources/domain/skillImportAnalysis.js";

const encoder = new TextEncoder();

const source: GithubSource = {
  kind: "repo", owner: "acme", repo: "ponytail", path: "",
  repositoryUrl: "https://github.com/acme/ponytail"
};

function archive(files: Record<string, string>): FetchedArchive {
  return {
    source,
    ref: "main",
    commit: "abc1234",
    root: "ponytail-abc1234",
    files: new Map(Object.entries(files).map(([path, content]) => [path, encoder.encode(content)]))
  };
}

function skill(name: string, body = `# ${name}\n\nUse ${name}.`): string {
  return `---\nname: ${name}\ndescription: '${name} does one thing.'\n---\n\n${body}\n`;
}

function ponytailFiles(): Record<string, string> {
  const skills = ["ponytail", "ponytail-audit", "ponytail-review", "ponytail-debt", "ponytail-gain", "ponytail-lite"];
  const files: Record<string, string> = {
    "LICENSE": "MIT License\n",
    ".opencode/command/ponytail-review.md": "---\ndescription: Review a change\nskill: ponytail-review\n---\n\nReview $ARGUMENTS.\n"
  };
  for (const id of skills) {
    files[`skills/${id}/SKILL.md`] = skill(id);
    files[`skills/${id}/reference.md`] = `Reference for ${id}`;
  }
  for (const id of skills) {
    files[`.opencode/command/${id}.md`] = `---\ndescription: ${id}\n---\n\nRun ${id}.\n`;
  }
  return files;
}

describe("skill pack import", () => {
  it("imports a deterministic sibling set without calling the analyzer", async () => {
    const analyzer = vi.fn();
    const result = await importSkillPack("https://github.com/acme/ponytail", { archive: archive(ponytailFiles()), analyzer });
    expect(analyzer).not.toHaveBeenCalled();
    expect(result.primarySkillId).toBe("ponytail");
    expect(result.draft.name).toBe("ponytail");
    expect(result.manifest.analysis.mode).toBe("deterministic");
    expect(result.manifest.skills).toHaveLength(6);
    expect(result.manifest.commands.filter((command) => command.status === "available")).toHaveLength(6);
    expect(result.manifest.license).toBe("LICENSE");
    expect(result.draft.content).toContain("name: ponytail");
    const paths = new Set((result.draft.files ?? []).map((file) => file.path));
    expect(paths.has("skill-packs/ponytail/pack.json")).toBe(true);
    expect(paths.has("skill-packs/ponytail/SOURCE.md")).toBe(true);
    expect(paths.has("skill-packs/ponytail/LICENSE")).toBe(true);
    expect(paths.has("skills/ponytail-review/SKILL.md")).toBe(true);
    expect(paths.has("skills/ponytail-review/reference.md")).toBe(true);
    expect(paths.has("skill-packs/ponytail/commands/shared/ponytail-review.md")).toBe(true);
    // The primary skill file is the draft content, never a duplicate companion.
    expect(paths.has("skills/ponytail/SKILL.md")).toBe(false);
    expect(paths.has("skills/ponytail/reference.md")).toBe(true);
    expect(result.report).toContain("Discovery: deterministic");
    expect(result.report).toContain("ponytail-review (available)");
  });

  it("records the repository release beside the pinned commit", async () => {
    const files = ponytailFiles();
    files["package.json"] = JSON.stringify({ name: "ponytail", version: "5.3.2" });
    files[".codex-plugin/plugin.json"] = JSON.stringify({ name: "ponytail", version: "5.3.2" });
    const result = await importSkillPack("https://github.com/acme/ponytail", { archive: archive(files) });
    expect(result.manifest.upstreamVersion).toBe("5.3.2");
    expect(result.report).toContain("Upstream version: 5.3.2");
    expect(result.report).toContain("Commit: abc1234");
  });

  it("falls back to plugin metadata and ignores a malformed version manifest", async () => {
    const files = ponytailFiles();
    files["package.json"] = "{not json";
    files[".codex-plugin/plugin.json"] = JSON.stringify({ version: "2.1.5" });
    const result = await importSkillPack("https://github.com/acme/ponytail", { archive: archive(files) });
    expect(result.manifest.upstreamVersion).toBe("2.1.5");
  });

  it("asks the analyzer only for an ambiguous set and installs only its selection", async () => {
    const files = archive({
      "packages/a/skills/review/SKILL.md": skill("review"),
      "packages/b/skills/deploy/SKILL.md": skill("deploy")
    });
    const analyzer = vi.fn(async (request: SkillImportAnalysisRequest) => {
      expect(request.candidates.map((candidate) => candidate.directory)).toEqual([
        "packages/a/skills/review", "packages/b/skills/deploy"
      ]);
      expect(JSON.stringify(request.candidates)).not.toContain("# review");
      return {
        packName: "review-pack",
        skillDirectories: ["packages/a/skills/review"],
        excluded: [{ path: "packages/b/skills/deploy", reason: "separate deployment pack" }],
        confidence: "high",
        summary: "Review only."
      };
    });
    const result = await importSkillPack("https://github.com/acme/skills", { archive: files, analyzer });
    expect(analyzer).toHaveBeenCalledOnce();
    expect(result.manifest.analysis.mode).toBe("ai");
    expect(result.manifest.skills.map((item) => item.id)).toEqual(["review"]);
    expect(result.manifest.analysis.skipped).toEqual([
      { path: "packages/b/skills/deploy", reason: "separate deployment pack" }
    ]);
    expect((result.draft.files ?? []).some((file) => file.path.startsWith("skills/deploy"))).toBe(false);
  });

  it("fails an ambiguous repository with candidate URLs when no analyzer exists", async () => {
    const files = archive({
      "packages/a/skills/review/SKILL.md": skill("review"),
      "packages/b/skills/deploy/SKILL.md": skill("deploy")
    });
    await expect(importSkillPack("https://github.com/acme/skills", { archive: files }))
      .rejects.toThrow(/tree\/main\/packages\/a\/skills\/review[\s\S]*tree\/main\/packages\/b\/skills\/deploy/);
  });

  it.each([
    ["unknown path", { packName: "p", skillDirectories: ["packages/a/skills/missing"], excluded: [], confidence: "high", summary: "" }],
    ["duplicate path", { packName: "p", skillDirectories: ["packages/a/skills/review", "packages/a/skills/review"], excluded: [], confidence: "high", summary: "" }],
    ["low confidence", { packName: "p", skillDirectories: ["packages/a/skills/review"], excluded: [], confidence: "low", summary: "" }],
    ["zero skills", { packName: "p", skillDirectories: [], excluded: [], confidence: "high", summary: "" }]
  ])("fails an invalid analyzer selection (%s) with candidate URLs", async (_name, selection) => {
    const files = archive({
      "packages/a/skills/review/SKILL.md": skill("review"),
      "packages/b/skills/deploy/SKILL.md": skill("deploy")
    });
    await expect(importSkillPack("https://github.com/acme/skills", { archive: files, analyzer: async () => selection }))
      .rejects.toThrow(/packages\/a\/skills\/review[\s\S]*packages\/b\/skills\/deploy/);
  });

  it("fails the whole pack when one selected skill violates a file limit", async () => {
    const files = ponytailFiles();
    files["skills/ponytail-audit/huge.bin"] = "x".repeat(SKILL_SUPPORT_FILE_MAX_BYTES + 1);
    await expect(importSkillPack("https://github.com/acme/ponytail", { archive: archive(files) }))
      .rejects.toThrow(`larger than ${SKILL_SUPPORT_FILE_MAX_BYTES} bytes`);
  });

  it("keeps the smaller SKILL.md limit", async () => {
    await expect(importSkillPack("https://github.com/acme/skills", { archive: archive({
      "skills/review/SKILL.md": skill("review", "x".repeat(SKILL_FILE_MAX_BYTES))
    }) })).rejects.toThrow(`SKILL.md is larger than ${SKILL_FILE_MAX_BYTES} bytes`);
  });

  it.each([0, 1])("counts the entire pack including generated files (excess: %s)", async (excess) => {
    const files: Record<string, string> = { "skills/review/SKILL.md": skill("review") };
    for (let index = 0; index < SKILL_PACK_MAX_FILES - 3 + excess; index++) {
      files[`skills/review/library/${index}.json`] = "{}";
    }
    const result = importSkillPack("https://github.com/acme/skills", { archive: archive(files) });
    if (excess) await expect(result).rejects.toThrow(`the limit is ${SKILL_PACK_MAX_FILES}`);
    else expect((await result).draft.files!.length + 1).toBe(SKILL_PACK_MAX_FILES);
  });

  it("imports a supporting file at the 25 MiB limit", async () => {
    const content = "x".repeat(SKILL_SUPPORT_FILE_MAX_BYTES);
    const result = await importSkillPack("https://github.com/acme/skills", { archive: archive({
      "skills/review/SKILL.md": skill("review"), "skills/review/library/data.json": content
    }) });
    expect(result.draft.files!.find((file) => file.path.endsWith("data.json"))!.content).toBe(content);
  });

  it("rejects a pack whose supporting files exceed the total byte limit", async () => {
    const files: Record<string, string> = { "skills/review/SKILL.md": skill("review") };
    for (let index = 0; index < SKILL_PACK_MAX_BYTES / SKILL_SUPPORT_FILE_MAX_BYTES; index++) {
      files[`skills/review/library/${index}.json`] = "x".repeat(SKILL_SUPPORT_FILE_MAX_BYTES);
    }
    await expect(importSkillPack("https://github.com/acme/skills", { archive: archive(files) }))
      .rejects.toThrow(`the limit is ${SKILL_PACK_MAX_BYTES}`);
  });

  it("excludes shallow-invalid candidates before choosing a pack", async () => {
    const files = archive({
      "skills/broken/SKILL.md": "---\nname: [one, two]\n---\n# Broken\n",
      "skills/working/SKILL.md": skill("working")
    });
    const result = await importSkillPack("https://github.com/acme/skills", { archive: files });
    expect(result.manifest.skills.map((item) => item.id)).toEqual(["working"]);
    expect(result.manifest.analysis.excluded).toContainEqual({
      path: "skills/broken", reason: expect.stringContaining("must be a single string value")
    });
  });

  it("fails when every candidate is shallow-invalid", async () => {
    const files = archive({ "skills/broken/SKILL.md": "# Broken\n" });
    files.files.set("skills/broken/SKILL.md", new Uint8Array([0xff, 0xfe, 0x00]));
    await expect(importSkillPack("https://github.com/acme/skills", { archive: files }))
      .rejects.toThrow("No candidate skill passed validation");
  });

  it("retains identical shared and Agent-specific skill versions", async () => {
    const files = archive({
      "skills/review/SKILL.md": skill("review"),
      ".openclaw/skills/review/SKILL.md": skill("review"),
      ".opencode/command/review.md": "---\nskill: review\n---\nReview $ARGUMENTS.\n"
    });
    const result = await importSkillPack("https://github.com/acme/skills", { archive: files });
    expect(result.manifest.skills.map((item) => item.agent).sort()).toEqual(["openclaw", "shared"]);
    expect(result.manifest.analysis.skipped).toEqual([]);
  });

  it("rejects duplicate ids case-insensitively", async () => {
    const files = archive({
      "one/review/SKILL.md": skill("Review"),
      "two/Review/SKILL.md": skill("Review")
    });
    await expect(importSkillPack("https://github.com/acme/skills", { archive: files }))
      .rejects.toThrow("same id");
  });

  it("treats a root SKILL.md as the whole repository and nested skills as support", async () => {
    const files = archive({
      "SKILL.md": skill("ponytail"),
      "references/inner/SKILL.md": skill("inner"),
      "references/guide.md": "Guide"
    });
    const result = await importSkillPack("https://github.com/acme/ponytail", { archive: files });
    expect(result.manifest.skills.map((item) => item.id)).toEqual(["ponytail"]);
    expect((result.draft.files ?? []).map((file) => file.path)).toContain("skills/ponytail/references/inner/SKILL.md");
    expect((result.draft.files ?? []).map((file) => file.path)).toContain("skills/ponytail/references/guide.md");
  });

  it("reports unsupported and unmapped commands but never copies them", async () => {
    const files = archive({
      "skills/review/SKILL.md": skill("review"),
      ".opencode/command/positional.md": "---\nskill: review\n---\nReview $1.\n",
      ".opencode/command/tools.md": "---\nskill: review\nallowed-tools: Bash\n---\nRun.\n",
      ".opencode/command/unmapped.md": "---\n---\nDo something.\n",
      ".opencode/command/good.md": "---\nskill: review\ndescription: Good\n---\nDo $ARGUMENTS.\n"
    });
    const result = await importSkillPack("https://github.com/acme/skills", { archive: files });
    const statuses = Object.fromEntries(result.manifest.commands.map((command) => [command.id, command.status]));
    expect(statuses).toEqual({ good: "available", positional: "unavailable", tools: "unavailable", unmapped: "unavailable" });
    const paths = (result.draft.files ?? []).map((file) => file.path);
    expect(paths).toContain("skill-packs/skills/commands/shared/good.md");
    expect(paths.some((path) => path.includes("positional") || path.includes("tools") || path.includes("unmapped"))).toBe(false);
    expect(result.report).toContain("Unavailable commands");
  });

  it("fails command-only repositories and direct command links", async () => {
    const files = archive({ ".opencode/command/review.md": "Review.\n" });
    await expect(importSkillPack("https://github.com/acme/skills", { archive: files }))
      .rejects.toThrow("commands but no SKILL.md");
    await expect(importSkillPack("https://github.com/acme/skills/blob/main/.opencode/command/review.md"))
      .rejects.toThrow("Only a SKILL.md file can be imported");
  });

  it("limits one import to a tree subtree", async () => {
    const files = archive({
      "skills/review/SKILL.md": skill("review"),
      "skills/deploy/SKILL.md": skill("deploy")
    });
    const result = await importSkillPack("https://github.com/acme/skills/tree/main/skills/review", { archive: files });
    expect(result.manifest.skills.map((item) => item.id)).toEqual(["review"]);
  });

  it("limits a raw SKILL.md link to its own skill directory", async () => {
    const files = archive({
      "LICENSE": "MIT License\n",
      "skills/review/SKILL.md": skill("review"),
      "skills/deploy/SKILL.md": skill("deploy")
    });
    const result = await importSkillPack(
      "https://raw.githubusercontent.com/acme/skills/main/skills/review/SKILL.md",
      { archive: files }
    );
    expect(result.manifest.skills.map((item) => item.id)).toEqual(["review"]);
    expect((result.draft.files ?? []).some((file) => file.path.startsWith("skills/deploy"))).toBe(false);
  });

  it("treats documentation and example copies as candidates that need a decision", async () => {
    const files = archive({
      "skills/review/SKILL.md": skill("review"),
      "examples/demo/SKILL.md": skill("demo")
    });
    await expect(importSkillPack("https://github.com/acme/skills", { archive: files }))
      .rejects.toThrow(/examples\/demo[\s\S]*skills\/review/);

    const onlyExample = archive({ "examples/demo/SKILL.md": skill("demo") });
    await expect(importSkillPack("https://github.com/acme/skills", { archive: onlyExample }))
      .rejects.toThrow(/documentation, test, or example[\s\S]*tree\/main\/examples\/demo/);
  });

  it("warns about name mismatch, a missing license, executable and binary support files", async () => {
    const files = archive({
      "skills/review/SKILL.md": "---\nname: Different\ndescription: Review a change\n---\n# Review\n",
      "skills/review/run.sh": "#!/bin/sh\necho review\n"
    });
    files.files.set("skills/review/blob.bin", new Uint8Array([0, 1, 2, 3]));
    const result = await importSkillPack("https://github.com/acme/skills", { archive: files });
    const warnings = result.manifest.skills[0]!.warnings.join("\n");
    expect(warnings).toContain("Front matter name 'Different' differs");
    expect(warnings).toContain("No LICENSE file");
    expect(warnings).toContain("executable text");
    expect(warnings).toContain("Skipped binary supporting file");
    expect((result.draft.files ?? []).some((file) => file.path.endsWith("blob.bin"))).toBe(false);
    expect((result.draft.files ?? []).some((file) => file.path.endsWith("run.sh"))).toBe(true);
  });

  it("preflights existing pack and skill directories and warns about cross-scope shadowing", async () => {
    const result = await importSkillPack("https://github.com/acme/ponytail", { archive: archive(ponytailFiles()) });
    await expect(preflightSkillPack(result.draft, { exists: async (path) => path === "skill-packs/ponytail" }))
      .rejects.toThrow("already installed");
    await expect(preflightSkillPack(result.draft, { exists: async (path) => path === "skills/ponytail-review" }))
      .rejects.toThrow("Skill 'ponytail-review' already exists");
    await expect(preflightSkillPack(result.draft, {
      exists: async () => false,
      otherScopeExists: async (path) => path === "skills/ponytail"
    })).resolves.toMatchObject({ warnings: [expect.stringContaining("other scope")] });

    await expect(preflightSkillPack({
      name: "review",
      content: "# Review\n",
      files: [
        { path: "skills/Review/a.md", content: "a" },
        { path: "skills/review/b.md", content: "b" },
        { path: "skill-packs/p/pack.json", content: "{}" }
      ]
    }, { exists: async () => false })).rejects.toThrow("declares both");
  });
});
