import { describe, expect, it } from "vitest";
import {
  parseSkillImportSelectionText,
  skillImportPrompt,
  validateSkillImportSelection,
  type SkillCandidateSummary
} from "../src/features/resources/domain/skillImportAnalysis.js";

const candidates: SkillCandidateSummary[] = [
  { directory: "packages/a/skills/review", id: "review", name: "Review", description: "Review a change", fileCount: 3, shallow: "ok" },
  { directory: "packages/b/skills/deploy", id: "deploy", name: "Deploy", description: "Deploy a change", fileCount: 2, shallow: "ok" }
];

describe("skill import analysis", () => {
  it("bounds candidate metadata and never sends a skill body", () => {
    const prompt = skillImportPrompt({
      repository: "https://github.com/acme/skills",
      sourceUrl: "https://github.com/acme/skills",
      candidates: [
        { ...candidates[0]!, description: "x".repeat(1000) },
        { ...candidates[1]!, shallow: "invalid", shallowReason: "empty body" }
      ]
    });
    expect(prompt).toContain("packages/a/skills/review");
    expect(prompt).toContain("empty body");
    expect(prompt).not.toContain("x".repeat(400));
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain('"skillDirectories"');
    expect(prompt).not.toContain("SKILL.md body");
  });

  it("accepts a selection made only of candidates", () => {
    const selection = validateSkillImportSelection({
      packName: "review-pack",
      skillDirectories: ["packages/a/skills/review"],
      excluded: [{ path: "packages/b/skills/deploy", reason: "different pack" }],
      confidence: "high",
      summary: "Review pack"
    }, candidates);
    expect(selection.skillDirectories).toEqual(["packages/a/skills/review"]);
  });

  it("rejects unknown, duplicate, out-of-scope, selected-and-excluded and low-confidence answers", () => {
    const base = {
      packName: "pack", skillDirectories: ["packages/a/skills/review"],
      excluded: [], confidence: "high", summary: ""
    };
    expect(() => validateSkillImportSelection({ ...base, skillDirectories: ["packages/a/skills/other"] }, candidates))
      .toThrow("not a candidate");
    expect(() => validateSkillImportSelection({ ...base, skillDirectories: ["packages/a/skills/review", "packages/a/skills/review"] }, candidates))
      .toThrow("same directory twice");
    expect(() => validateSkillImportSelection({ ...base, skillDirectories: ["../escape"] }, candidates))
      .toThrow("traverses outside the repository");
    expect(() => validateSkillImportSelection({ ...base, excluded: [{ path: "../escape", reason: "x" }] }, candidates))
      .toThrow("traverses outside the repository");
    expect(() => validateSkillImportSelection({ ...base, skillDirectories: [], packName: "" }, candidates))
      .toThrow("invalid selection");
    expect(() => validateSkillImportSelection({ ...base, confidence: "low" }, candidates))
      .toThrow("not confident enough");
    expect(() => validateSkillImportSelection({ ...base, excluded: [{ path: "packages/a/skills/review", reason: "x" }] }, candidates))
      .toThrow("both selected and excluded");
  });

  it("parses structured and fenced replies", () => {
    expect(parseSkillImportSelectionText('{"packName":"p"}')).toEqual({ packName: "p" });
    expect(parseSkillImportSelectionText('Here:\n```json\n{"packName":"p"}\n```')).toEqual({ packName: "p" });
    expect(() => parseSkillImportSelectionText("not json")).toThrow("did not return valid JSON");
  });
});
