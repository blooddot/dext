import { describe, expect, it } from "vitest";
import type { FetchedArchive } from "../src/features/resources/host/githubArchive.js";
import { importSkillPack } from "../src/features/resources/host/skillImporter.js";

const ROOT = "https://github.com/acme/demo";
const encoder = new TextEncoder();
const skill = (name: string): string => `---\nname: ${name}\ndescription: Work on ${name}.\n---\n\nUse ${name}.\n`;

/** The command shape a native plugin manifest ships: it locates itself through
 * the plugin root variable rather than a literal path. */
const ACTIVATE = "node -e \"require(require('path').join(process.env.CLAUDE_PLUGIN_ROOT, 'hooks', 'activate.js'))\"";

function archive(contents: Record<string, string>): FetchedArchive {
  return {
    source: { kind: "repo", owner: "acme", repo: "demo", path: "", repositoryUrl: ROOT },
    ref: "main",
    commit: "abc1234",
    files: new Map(Object.entries(contents).map(([path, content]) => [path, encoder.encode(content)]))
  };
}

describe("skill pack hook import", () => {
  const contents = {
    ".claude-plugin/plugin.json": JSON.stringify({ skills: "./skills", hooks: ["./hooks/hooks.json"] }),
    "hooks/hooks.json": JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: ACTIVATE, timeout: 15 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node -e \"require('./hooks/tracker.js')\"" }] }],
        Stop: [{ hooks: [{ type: "module", module: "./hooks/band/register.tsx" }] }]
      }
    }),
    "hooks/activate.js": "const fs = require('fs'); fs.readFileSync(__dirname + '/../skills/demo/SKILL.md');",
    "hooks/tracker.js": "process.exit(0);",
    "hooks/band/register.tsx": "export {};",
    "skills/demo/SKILL.md": skill("demo"),
    "skills/demo/reference.md": "Reference",
    ".codex-plugin/plugin.json": JSON.stringify({ skills: "./skills", hooks: "./hooks/hooks.json" })
  };

  it("records command hooks and mirrors the files they read", async () => {
    const result = await importSkillPack(ROOT, { archive: archive(contents) });
    expect(result.manifest.hooks).toMatchObject([
      { agent: "claude", event: "SessionStart", matcher: "startup|resume", command: ACTIVATE, timeout: 15, root: "" },
      { agent: "claude", event: "UserPromptSubmit", command: "node -e \"require('./hooks/tracker.js')\"" },
      { agent: "codex", event: "SessionStart", matcher: "startup|resume", command: ACTIVATE, timeout: 15 },
      { agent: "codex", event: "UserPromptSubmit", command: "node -e \"require('./hooks/tracker.js')\"" }
    ]);
    expect(result.report).toContain("## Hooks");
    expect(result.report).toContain(ACTIVATE);
    expect(result.report).toContain("only command hooks are recorded");
    const paths = new Set((result.draft.files ?? []).map((file) => file.path));
    for (const path of [
      "skill-packs/demo/upstream/hooks/hooks.json",
      "skill-packs/demo/upstream/hooks/activate.js",
      "skill-packs/demo/upstream/hooks/band/register.tsx",
      "skill-packs/demo/upstream/skills/demo/SKILL.md",
      "skill-packs/demo/upstream/skills/demo/reference.md"
    ]) expect(paths.has(path)).toBe(true);
  });

  it("installs no hook for a pack that declares none", async () => {
    const result = await importSkillPack(ROOT, { archive: archive({ "skills/demo/SKILL.md": skill("demo") }) });
    expect(result.manifest.hooks).toBeUndefined();
    expect((result.draft.files ?? []).some((file) => file.path.includes("/upstream/"))).toBe(false);
  });

  it("keeps a malformed hook configuration out of the manifest", async () => {
    const result = await importSkillPack(ROOT, {
      archive: archive({
        ".claude-plugin/plugin.json": JSON.stringify({ skills: "./skills", hooks: "./hooks/hooks.json" }),
        "hooks/hooks.json": "{ not json",
        "skills/demo/SKILL.md": skill("demo")
      })
    });
    expect(result.manifest.hooks).toBeUndefined();
    expect(result.report).toContain("hook configuration is not valid JSON");
    // The file is still copied: the pack owns what the repository shipped.
    expect((result.draft.files ?? []).some((file) => file.path.endsWith("upstream/hooks/hooks.json"))).toBe(true);
  });
});
