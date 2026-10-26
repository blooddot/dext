import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importSkillPack } from "../src/features/resources/host/skillImporter.js";
import type { FetchedArchive } from "../src/features/resources/host/githubArchive.js";
import { SkillCatalog } from "../src/features/workflow/host/skillCatalog.js";
import { normalizeSkillPackManifest } from "../src/features/resources/domain/skillPack.js";

const ROOT = "https://github.com/acme/pack";
const skill = (name: string, body = "Shared instructions"): string => `---\nname: ${name}\ndescription: Work on ${name}.\n---\n${body}\n`;
const command = (body: string, fields = ""): string => `---\nskill: review\n${fields}---\n${body}\n`;
function archive(contents: Record<string, string>): FetchedArchive {
  return { source: { kind: "repo", owner: "acme", repo: "pack", path: "", repositoryUrl: ROOT },
    ref: "main", commit: "abc1234",
    files: new Map(Object.entries(contents).map(([path, text]) => [path, new TextEncoder().encode(text)])) };
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function install(contents: Record<string, string>) {
  const result = await importSkillPack(ROOT, { archive: archive(contents) });
  const root = await mkdtemp(join(tmpdir(), "dext-variants-"));
  roots.push(root);
  for (const file of [{ path: `skills/${result.draft.name}/SKILL.md`, content: result.draft.content }, ...result.draft.files ?? []]) {
    const path = join(root, ".dext", file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }
  const catalog = new SkillCatalog();
  await catalog.reload(root);
  return { ...result, root, catalog };
}

describe("import all Skill versions and resolve per Agent", () => {
  it("imports once and switches versions at use time with shared fallback", async () => {
    const result = await install({
      "skills/review/SKILL.md": skill("review", "Shared review"),
      "skills/review/reference.md": "Shared support",
      ".codex/skills/review/SKILL.md": skill("review", "Codex review"),
      ".codex/skills/review/reference.md": "Codex support",
      ".claude/skills/review/SKILL.md": skill("review", "Claude review"),
      "skills/deploy/SKILL.md": skill("deploy", "Shared deploy")
    });
    expect(result.manifest.version).toBe(2);
    expect(result.manifest.targetAgent).toBeUndefined();
    expect(result.manifest.skills).toHaveLength(4);
    expect(result.catalog.list("codex").map((entry) => entry.id)).toEqual(["deploy", "review"]);
    expect(result.catalog.list("codex").find((entry) => entry.id === "review")?.variant).toBe("codex");
    expect(result.catalog.list("claude").find((entry) => entry.id === "review")?.variant).toBe("claude");
    expect(result.catalog.list("pi").find((entry) => entry.id === "review")?.variant).toBe("shared");
    const codex = await result.catalog.load("review", result.root, ".", "codex");
    expect(codex.instructions).toContain("Codex review");
    expect(codex.sourcePath).toContain(join("variants", "codex", "skills", "review", "SKILL.md"));
    expect(await result.catalog.load("review", result.root, ".", "claude")).toMatchObject({ instructions: expect.stringContaining("Claude review") });
    expect(await result.catalog.load("review", result.root, ".", "pi")).toMatchObject({ instructions: expect.stringContaining("Shared review") });
    expect(await result.catalog.load("deploy", result.root, ".", "codex")).toMatchObject({ instructions: expect.stringContaining("Shared deploy") });
    expect(result.report).toContain("all imported");
    expect(result.report).toContain(".codex/skills/review (codex)");
  });

  it("never falls back to another CLI when a shared version does not exist", async () => {
    const result = await install({ ".claude/skills/review/SKILL.md": skill("review", "Claude only") });
    expect(result.catalog.list("codex")[0]?.available).toBe(false);
    expect(result.catalog.list("claude")[0]?.available).toBe(true);
    await expect(result.catalog.load("review", result.root, ".", "codex")).rejects.toThrow("no 'codex' version or shared fallback");
    await expect(result.catalog.load("review", result.root, ".", "claude")).resolves.toMatchObject({ instructions: expect.stringContaining("Claude only") });
  });

  it("keeps distinct Agent mappings even when their complete trees match", async () => {
    const result = await install({
      "skills/review/SKILL.md": skill("review"), ".claude/skills/review/SKILL.md": skill("review")
    });
    expect(result.manifest.skills).toHaveLength(2);
    expect(result.catalog.list("claude")[0]?.variant).toBe("claude");
    expect(result.catalog.list("codex")[0]?.variant).toBe("shared");
  });

  it("deduplicates equivalent copies of the same Agent version", async () => {
    const result = await install({
      "skills/review/SKILL.md": skill("review"), ".agents/skills/review/SKILL.md": skill("review")
    });
    expect(result.manifest.skills).toHaveLength(1);
    expect(result.report).toContain("Identical skill tree for the same Agent");
  });

  it("rejects different same-Agent sources without merging or opening a picker", async () => {
    await expect(importSkillPack(ROOT, { archive: archive({
      "packages/a/skills/review/SKILL.md": skill("review", "A"),
      "packages/b/skills/review/SKILL.md": skill("review", "B")
    }) })).rejects.toThrow("Different shared variants");
  });

  it("compares supporting files when deduplicating the same Agent version", async () => {
    await expect(importSkillPack(ROOT, { archive: archive({
      "skills/review/SKILL.md": skill("review"), "skills/review/reference.md": "A",
      ".agents/skills/review/SKILL.md": skill("review"), ".agents/skills/review/reference.md": "B"
    }) })).rejects.toThrow("Different shared variants");
  });

  it("honors subtree import scope", async () => {
    const result = await importSkillPack(`${ROOT}/tree/main/.claude/skills/review`, { archive: archive({
      "skills/review/SKILL.md": skill("review"), ".claude/skills/review/SKILL.md": skill("review", "Claude")
    }) });
    expect(result.manifest.skills).toHaveLength(1);
    expect(result.manifest.skills[0]?.agent).toBe("claude");
  });

  it("recognizes custom plugin roots and keeps native hooks out of the install", async () => {
    const result = await install({
      ".codex-plugin/plugin.json": JSON.stringify({ skills: "./codex-prompts/", hooks: "./hooks.json" }),
      ".claude-plugin/plugin.json": JSON.stringify({ skills: ["./claude-prompts/"] }),
      "codex-prompts/review/SKILL.md": skill("review", "Codex"),
      "claude-prompts/review/SKILL.md": skill("review", "Claude"), "hooks.json": "{}"
    });
    expect(result.manifest.skills).toHaveLength(2);
    expect(normalizeSkillPackManifest(result.manifest, "pack")?.version).toBe(2);
    expect(result.report).toContain("native plugin configuration and hooks are not installed");
    expect(result.draft.files?.some((file) => file.path.endsWith("hooks.json"))).toBe(false);
  });

  it("records unknown sources without treating them as shared fallback", async () => {
    const result = await install({ "prompts/review/SKILL.md": skill("review") });
    expect(result.manifest.skills[0]?.agent).toBe("unknown");
    await expect(result.catalog.load("review", result.root, ".", "codex")).rejects.toThrow("shared fallback");
  });

  it("retains all variants of a logical skill chosen by ambiguous-pack analysis", async () => {
    const analyzer = vi.fn(async () => ({ packName: "review", skillDirectories: ["packages/a/skills/review"],
      excluded: [], confidence: "high", summary: "Review pack" }));
    const result = await importSkillPack(ROOT, { archive: archive({
      "packages/a/skills/review/SKILL.md": skill("review"),
      "packages/a/.claude/skills/review/SKILL.md": skill("review", "Claude"),
      "packages/b/skills/deploy/SKILL.md": skill("deploy")
    }), analyzer });
    expect(analyzer).toHaveBeenCalledOnce();
    expect(result.manifest.skills.map((item) => item.agent).sort()).toEqual(["claude", "shared"]);
  });

  it("keeps legacy fixed-version packs usable across Agents", async () => {
    const result = await install({ "skills/review/SKILL.md": skill("review", "Legacy instructions") });
    await writeFile(join(result.root, ".dext", "skill-packs", "pack", "pack.json"), JSON.stringify({
      ...result.manifest, version: 1, targetAgent: "claude",
      skills: result.manifest.skills.map((entry) => ({ ...entry, agent: "claude" }))
    }));
    await result.catalog.reload(result.root);
    await expect(result.catalog.load("review", result.root, ".", "codex")).resolves.toMatchObject({ instructions: expect.stringContaining("Legacy instructions") });
    expect(result.catalog.list("codex")[0]?.available).toBeUndefined();
  });
});

describe("commands resolve per turn Agent", () => {
  it("imports all compatible command versions and selects exact then shared", async () => {
    const result = await install({
      "skills/review/SKILL.md": skill("review"),
      ".claude/commands/review.md": command("Claude $ARGUMENTS"),
      ".codex/commands/review.md": command("Codex $ARGUMENTS", "model: preferred-model\n"),
      "commands/review.md": command("Shared $ARGUMENTS")
    });
    expect(result.manifest.commands.filter((item) => item.status === "available")).toHaveLength(3);
    for (const [agent, body] of [["codex", "Codex"], ["claude", "Claude"], ["pi", "Shared"]]) {
      expect(result.catalog.resolveCommand("review", ["review"], "now", agent)).toMatchObject({
        status: "ok", command: { instruction: `${body} now` }
      });
      expect(result.catalog.commands(agent).map((item) => item.id)).toEqual(["review"]);
    }
  });

  it("does not let an unsupported native template block a shared alternative", async () => {
    const result = await install({
      "skills/review/SKILL.md": skill("review"), ".claude/commands/review.md": command("Review $1", "allowed-tools: Bash\n"),
      "commands/review.md": command("Shared $ARGUMENTS")
    });
    expect(result.catalog.resolveCommand("review", ["review"], "now", "claude")).toMatchObject({ status: "ok", command: { instruction: "Shared now" } });
  });

  it("makes a lone compatible OpenCode prompt available as a shared Dext command", async () => {
    const result = await install({
      "skills/review/SKILL.md": skill("review"), ".opencode/command/review.md": command("Review $ARGUMENTS")
    });
    expect(result.manifest.commands[0]).toMatchObject({ agent: "shared", sourceAgent: "opencode" });
    expect(result.catalog.resolveCommand("review", ["review"], "now", "codex")).toMatchObject({ status: "ok" });
  });

  it("does not offer or run another CLI's command without a shared alternative", async () => {
    const result = await install({
      "skills/review/SKILL.md": skill("review"), ".claude/commands/review.md": command("Claude only")
    });
    expect(result.catalog.commands("codex")).toEqual([]);
    expect(result.catalog.resolveCommand("review", ["review"], "", "codex")).toMatchObject({ status: "invalid" });
    expect(result.catalog.resolveCommand("review", ["review"], "", "claude")).toMatchObject({ status: "ok" });
  });
});
