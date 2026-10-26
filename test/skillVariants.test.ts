import { describe, expect, it, vi } from "vitest";
import { importSkillPack } from "../src/features/resources/host/skillImporter.js";
import type { FetchedArchive } from "../src/features/resources/host/githubArchive.js";
import { normalizeSkillPackManifest } from "../src/features/resources/domain/skillPack.js";
import type { ImportTargetRequest, ImportVariantRequest } from "../src/features/resources/domain/skillImportVariants.js";

const ROOT = "https://github.com/acme/pack";
const skill = (name: string, body = "Shared instructions"): string => `---\nname: ${name}\ndescription: Work on ${name}.\n---\n${body}\n`;
const command = (body: string, fields = ""): string => `---\nskill: review\n${fields}---\n${body}\n`;
function archive(contents: Record<string, string>): FetchedArchive {
  return {
    source: { kind: "repo", owner: "acme", repo: "pack", path: "", repositoryUrl: ROOT },
    ref: "main", commit: "abc1234",
    files: new Map(Object.entries(contents).map(([path, text]) => [path, new TextEncoder().encode(text)]))
  };
}

describe("multi-agent skill imports", () => {
  it("asks once for a target, prefers its variants and fills gaps with shared skills", async () => {
    const chooseTarget = vi.fn(async (request: ImportTargetRequest) => {
      expect(request.recommended).toBe("codex");
      expect(request.targets).toEqual(expect.arrayContaining(["shared", "codex", "claude"]));
      return "codex";
    });
    const analyzer = vi.fn();
    const result = await importSkillPack(ROOT, { archive: archive({
      "skills/review/SKILL.md": skill("review"),
      "skills/deploy/SKILL.md": skill("deploy"),
      ".codex/skills/review/SKILL.md": skill("review", "Codex instructions"),
      ".claude/skills/review/SKILL.md": skill("review", "Claude instructions"),
      ".claude/skills/claude-only/SKILL.md": skill("claude-only")
    }), preferredAgent: "codex", chooseTarget, analyzer });
    expect(chooseTarget).toHaveBeenCalledOnce();
    expect(analyzer).not.toHaveBeenCalled();
    expect(result.manifest.targetAgent).toBe("codex");
    expect(result.manifest.skills.map((item) => item.directory)).toEqual([".codex/skills/review", "skills/deploy"]);
    expect(result.report).toContain("Skill review: .codex/skills/review (codex)");
    expect(result.report).toContain("claude variant excluded");
    expect(result.manifest.analysis.skipped.find((item) => item.path === "skills/review")?.reason).toContain("Different shared variant");
  });

  it.each([ROOT, `${ROOT}/tree/main`])("does not silently prefer a visible copy for %s", async (url) => {
    const files = archive({
      "skills/review/SKILL.md": skill("review"),
      ".claude/skills/review/SKILL.md": skill("review", "Different instructions")
    });
    await expect(importSkillPack(url, { archive: files })).rejects.toThrow("Choose an import target");
    const result = await importSkillPack(ROOT, { archive: files, targetAgent: "shared" });
    expect(result.manifest.skills[0]?.directory).toBe("skills/review");
  });

  it("compares supporting files as well as the main instructions", async () => {
    const chooseTarget = vi.fn(async () => "shared");
    const result = await importSkillPack(ROOT, { archive: archive({
      "skills/review/SKILL.md": skill("review"), "skills/review/reference.md": "Shared support",
      ".codex/skills/review/SKILL.md": skill("review"), ".codex/skills/review/reference.md": "Different support"
    }), chooseTarget });
    expect(chooseTarget).toHaveBeenCalledOnce();
    expect(result.manifest.analysis.skipped[0]?.reason).toContain("Different codex variant");
  });

  it("merges identical complete trees without prompting", async () => {
    const chooseTarget = vi.fn();
    const chooseVariant = vi.fn();
    const result = await importSkillPack(ROOT, { archive: archive({
      "skills/review/SKILL.md": skill("review"), "skills/review/reference.md": "Same",
      ".claude/skills/review/SKILL.md": skill("review"), ".claude/skills/review/reference.md": "Same"
    }), chooseTarget, chooseVariant });
    expect(chooseTarget).not.toHaveBeenCalled();
    expect(chooseVariant).not.toHaveBeenCalled();
    expect(result.manifest.skills[0]?.directory).toBe("skills/review");
    expect(result.report).toContain("Identical skill tree");
  });

  it("asks for an exact source when two different variants have the same target", async () => {
    const chooseVariant = vi.fn(async (request: ImportVariantRequest) => {
      expect(request.kind).toBe("skill");
      expect(request.sources.map((source: { path: string }) => source.path)).toEqual(["packages/a/skills/review", "packages/b/skills/review"]);
      return "packages/b/skills/review";
    });
    const result = await importSkillPack(ROOT, { archive: archive({
      "packages/a/skills/review/SKILL.md": skill("review", "A"), "packages/b/skills/review/SKILL.md": skill("review", "B")
    }), targetAgent: "shared", chooseVariant });
    expect(chooseVariant).toHaveBeenCalledOnce();
    expect(result.manifest.skills[0]?.directory).toBe("packages/b/skills/review");
  });

  it("uses a direct Agent-specific tree link as the explicit source choice", async () => {
    const chooseTarget = vi.fn();
    const result = await importSkillPack(`${ROOT}/tree/main/.claude/skills/review`, { archive: archive({
      "skills/review/SKILL.md": skill("review"), ".claude/skills/review/SKILL.md": skill("review", "Claude instructions")
    }), preferredAgent: "codex", chooseTarget });
    expect(chooseTarget).not.toHaveBeenCalled();
    expect(result.manifest.targetAgent).toBe("claude");
    expect(result.manifest.skills[0]?.agent).toBe("claude");
  });

  it("reads custom paths from plugin manifests and records skipped native functionality", async () => {
    const result = await importSkillPack(ROOT, { archive: archive({
      ".codex-plugin/plugin.json": JSON.stringify({ skills: "./codex-prompts/", hooks: "./hooks.json" }),
      ".claude-plugin/plugin.json": JSON.stringify({ skills: ["./claude-prompts/"] }),
      "codex-prompts/review/SKILL.md": skill("review", "Codex instructions"),
      "claude-prompts/review/SKILL.md": skill("review", "Claude instructions"), "hooks.json": "{}"
    }), targetAgent: "codex" });
    expect(result.manifest.skills[0]?.directory).toBe("codex-prompts/review");
    expect(result.manifest.skills[0]?.agent).toBe("codex");
    expect(result.report).toContain("native plugin configuration and hooks are not installed");
    expect(result.draft.files?.some((file) => file.path.endsWith("hooks.json"))).toBe(false);
    expect(normalizeSkillPackManifest(result.manifest, "pack")?.targetAgent).toBe("codex");
    expect(normalizeSkillPackManifest(result.manifest, "pack")?.skills[0]?.agent).toBe("codex");
  });

  it("ignores unsafe manifest paths without turning them into candidates", async () => {
    const result = await importSkillPack(ROOT, { archive: archive({
      ".codex-plugin/plugin.json": JSON.stringify({ skills: "../outside" }), "skills/review/SKILL.md": skill("review")
    }) });
    expect(result.report).toContain("ignored unsafe skill path");
    expect(result.manifest.skills[0]?.agent).toBe("shared");
  });

  it.each([undefined, "outside"])("rejects a cancelled or invalid target (%s)", async (answer) => {
    await expect(importSkillPack(ROOT, { archive: archive({
      "skills/review/SKILL.md": skill("review"), ".codex/skills/review/SKILL.md": skill("review", "Different")
    }), chooseTarget: async () => answer })).rejects.toThrow(answer ? "not available" : "stopped");
  });

  it("rejects a variant selector that invents a source", async () => {
    await expect(importSkillPack(ROOT, { archive: archive({
      "a/review/SKILL.md": skill("review", "A"), "b/review/SKILL.md": skill("review", "B")
    }), chooseVariant: async () => "outside/review" })).rejects.toThrow("not an offered source");
  });
});

describe("multi-agent command imports", () => {
  it("chooses target-specific templates instead of the first path", async () => {
    const result = await importSkillPack(ROOT, { archive: archive({
      "skills/review/SKILL.md": skill("review"), ".claude/commands/review.md": command("Claude review"),
      ".codex/commands/review.md": command("Codex review", "model: preferred-model\nagent: codex\n"),
      "commands/review.md": command("Shared review")
    }), targetAgent: "codex" });
    const available = result.manifest.commands.filter((item) => item.status === "available");
    expect(available).toHaveLength(1);
    expect(available[0]?.source).toBe(".codex/commands/review.md");
    expect(available[0]?.warnings?.[0]).toContain("Ignored routing fields");
    expect(result.report).toContain("Command /review: .codex/commands/review.md (codex)");
    expect(result.report).toContain("different variant");
  });

  it("does not let an unsupported command block a later compatible variant", async () => {
    const result = await importSkillPack(ROOT, { archive: archive({
      "skills/review/SKILL.md": skill("review"),
      ".claude/commands/review.md": command("Review $1", "allowed-tools: Bash\n"),
      "commands/review.md": command("Review $ARGUMENTS")
    }), targetAgent: "claude" });
    expect(result.manifest.commands.find((item) => item.status === "available")?.source).toBe("commands/review.md");
    expect(result.manifest.commands.find((item) => item.status === "unavailable")?.reason).toContain("Unsupported");
  });

  it("asks when equally ranked foreign command variants differ", async () => {
    const chooseVariant = vi.fn(async (request: ImportVariantRequest) => {
      expect(request.kind).toBe("command");
      return ".opencode/command/review.md";
    });
    const files = archive({
      "skills/review/SKILL.md": skill("review"), ".claude/commands/review.md": command("Claude template"),
      ".opencode/command/review.md": command("OpenCode template")
    });
    await expect(importSkillPack(ROOT, { archive: files, targetAgent: "shared" })).rejects.toThrow("Choose a command variant");
    const result = await importSkillPack(ROOT, { archive: files, targetAgent: "shared", chooseVariant });
    expect(chooseVariant).toHaveBeenCalledOnce();
    expect(result.manifest.commands.find((item) => item.status === "available")?.source).toBe(".opencode/command/review.md");
    expect(result.report).toContain("Adapted a compatible opencode prompt template");
  });

  it("merges identical command templates without asking", async () => {
    const chooseVariant = vi.fn();
    const result = await importSkillPack(ROOT, { archive: archive({
      "skills/review/SKILL.md": skill("review"), ".claude/commands/review.md": command("Review $ARGUMENTS"),
      ".opencode/command/review.md": command("Review $ARGUMENTS")
    }), targetAgent: "shared", chooseVariant });
    expect(chooseVariant).not.toHaveBeenCalled();
    expect(result.manifest.commands.filter((item) => item.status === "available")).toHaveLength(1);
    expect(result.report).toContain("identical template");
  });
});
