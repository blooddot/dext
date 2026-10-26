import { describe, expect, it } from "vitest";
import { parseSkillMetadata, splitFrontMatter } from "../src/features/workflow/domain/skillMetadata.js";

describe("parseSkillMetadata", () => {
  it("parses folded and quoted scalars instead of showing the YAML marker", () => {
    const skill = parseSkillMetadata([
      "---",
      "name: 'Review helper'",
      "description: >",
      "  Review a change before it ships.",
      "  Keep the report short.",
      "license: MIT",
      "---",
      "",
      "# Review",
      "",
      "Body."
    ].join("\n"), "review");
    expect(skill.title).toBe("Review helper");
    expect(skill.description).toBe("Review a change before it ships. Keep the report short.");
    expect(skill.license).toBe("MIT");
    expect(skill.hasFrontMatter).toBe(true);
    expect(skill.diagnostics).toEqual([]);
    expect(skill.body).toBe("# Review\n\nBody.");
  });

  it("falls back to the H1 and first paragraph", () => {
    const skill = parseSkillMetadata("# Feature\n\nBuild the smallest thing.\nSecond line.\n\nMore.", "dev-feat");
    expect(skill.title).toBe("Feature");
    expect(skill.description).toBe("Build the smallest thing. Second line.");
    expect(skill.hasFrontMatter).toBe(false);
  });

  it("reports malformed YAML and non-scalar fields without throwing", () => {
    const malformed = parseSkillMetadata("---\nname: [unclosed\n---\n# Title\n", "fallback");
    expect(malformed.title).toBe("Title");
    expect(malformed.diagnostics.join(" ")).toMatch(/Invalid YAML front matter/);

    const list = parseSkillMetadata("---\nname: [one, two]\ndescription: 42\n---\n# Title\n", "fallback");
    expect(list.title).toBe("Title");
    expect(list.diagnostics).toEqual([
      "Front matter 'name' must be a single string value.",
      "Front matter 'description' must be a string, not number."
    ]);
  });

  it("tolerates an unquoted description containing a colon", () => {
    const skill = parseSkillMetadata("---\nname: Audit\ndescription: Quality audit: bugs, security, load\n---\n# Audit\n", "audit");
    expect(skill.title).toBe("Audit");
    expect(skill.description).toBe("Quality audit: bugs, security, load");
    expect(skill.diagnostics).toEqual([]);
  });

  it("reports an unclosed front matter block", () => {
    const split = splitFrontMatter("---\nname: review\n# Body\n");
    expect(split.present).toBe(true);
    expect(split.data).toEqual({});
    expect(split.diagnostics).toEqual(["Front matter is not closed by a --- line."]);
  });

  it("keeps the fallback description when no paragraph exists", () => {
    const skill = parseSkillMetadata("# Title\n", "title");
    expect(skill.description).toBe("Standard project skill.");
  });
});
