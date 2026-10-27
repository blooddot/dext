import { describe, expect, it } from "vitest";
import { formatSkillPackReport, normalizeSkillPackManifest, skillPackId } from "../src/features/resources/domain/skillPack.js";

const manifest = {
  name: "ponytail",
  source: "https://github.com/DietrichGebert/ponytail",
  releaseTag: "v5.3.2",
  upstreamVersion: "5.3.2",
  commit: "abc123",
  license: "MIT",
  importedAt: "2026-10-26T00:00:00.000Z",
  skills: [{ id: "ponytail", name: "Ponytail", description: "Lean code", directory: "skills/ponytail", commands: ["ponytail-review"], warnings: [] }],
  commands: [{ id: "ponytail-review", title: "Review", description: "Review", skillId: "ponytail", source: ".opencode/command/review.md", file: "skill-packs/ponytail/commands/ponytail-review.md", status: "available" }],
  analysis: {
    mode: "ai",
    summary: "Selected the ponytaill skill.",
    confidence: "high",
    selected: ["skills/ponytail"],
    excluded: [],
    skipped: [{ path: "examples/demo", reason: "example directory" }]
  }
};

describe("skill pack manifest", () => {
  it("normalizes a manifest and keeps the analysis decision", () => {
    const normalized = normalizeSkillPackManifest(manifest, "fallback");
    expect(normalized?.analysis).toMatchObject({
      mode: "ai",
      confidence: "high",
      selected: ["skills/ponytail"],
      skipped: [{ path: "examples/demo", reason: "example directory" }]
    });
    expect(normalized?.commands).toEqual([expect.objectContaining({ id: "ponytail-review", status: "available" })]);
  });

  it("defaults a missing analysis to deterministic", () => {
    const normalized = normalizeSkillPackManifest({ ...manifest, analysis: undefined }, "fallback");
    expect(normalized?.analysis.mode).toBe("deterministic");
    expect(normalized?.analysis.selected).toEqual(["skills/ponytail"]);
  });

  it("rejects a manifest without skills so the catalog can ignore it", () => {
    expect(normalizeSkillPackManifest({ name: "empty", skills: [] }, "fallback")).toBeUndefined();
    expect(normalizeSkillPackManifest(undefined, "fallback")).toBeUndefined();
  });

  it("derives safe pack ids", () => {
    expect(skillPackId("Ponytail Skills")).toBe("ponytail-skills");
    expect(skillPackId("../../etc")).toBe("etc");
    expect(skillPackId("")).toBe("skill-pack");
  });

  it("formats a report with the discovery mode and skipped candidates", () => {
    const report = formatSkillPackReport(normalizeSkillPackManifest(manifest, "fallback")!);
    expect(report).toContain("Discovery: AI-assisted selection");
    expect(report).toContain("Release: v5.3.2");
    expect(report).toContain("Upstream version: 5.3.2");
    expect(report).toContain("examples/demo: example directory");
    expect(report).toContain("Commands: ponytail-review (available)");
  });
});
