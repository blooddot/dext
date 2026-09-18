import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) } }));

const configuration = (values: Record<string, unknown>, inspectable = false) => ({
  get: <T>(section: string, fallback: T): T => (values[section] !== undefined ? values[section] as unknown as T : fallback),
  ...(inspectable
    ? { inspect: <T>(section: string) => (values[section] !== undefined ? { globalValue: values[section] as unknown as T } : undefined) }
    : {})
});

describe("project AI budgets", () => {
  it("uses the documented defaults without a configuration", async () => {
    const { projectAiLimits, projectEvidenceLimits } = await import("../src/projectAiLimits.js");
    const evidence = projectEvidenceLimits(configuration({}));
    expect(evidence).toEqual({ maxFiles: 600, maxSourceFiles: 600, maxFileChars: 16_000, maxEvidenceChars: 600_000, include: [], preset: "standard" });
    expect(projectAiLimits(configuration({}))).toEqual({ maxInputChars: 760_000, maxOutputChars: 240_000, maxOutputTokens: 32_000 });
  });

  it("scales every budget with the depth preset", async () => {
    const { projectEvidenceLimits } = await import("../src/projectAiLimits.js");
    const deep = projectEvidenceLimits(configuration({ "project.evidenceDepth": "deep" }));
    expect(deep).toMatchObject({ maxEvidenceChars: 900_000, maxFiles: 800, maxFileChars: 20_000, preset: "deep" });
    const whole = projectEvidenceLimits(configuration({ "project.evidenceDepth": "whole" }));
    expect(whole).toMatchObject({ maxEvidenceChars: 1_200_000, maxFiles: 1_000, maxFileChars: 24_000, preset: "whole" });
    // An unknown preset name never becomes an unbounded budget.
    expect(projectEvidenceLimits(configuration({ "project.evidenceDepth": "enormous" }))).toMatchObject({ preset: "standard", maxEvidenceChars: 600_000 });
  });

  it("lets an explicitly configured limit override the preset", async () => {
    const { projectEvidenceLimits } = await import("../src/projectAiLimits.js");
    // With VS Code's inspect() a preset wins unless the reader set the value themselves.
    expect(projectEvidenceLimits(configuration({ "project.evidenceDepth": "deep" }, true))).toMatchObject({ maxEvidenceChars: 900_000 });
    expect(projectEvidenceLimits(configuration({ "project.evidenceDepth": "deep", "project.evidenceChars": 300_000 }, true)))
      .toMatchObject({ maxEvidenceChars: 300_000, maxFiles: 800 });
    // A value outside the documented range falls back to the preset instead of reaching the service.
    expect(projectEvidenceLimits(configuration({ "project.evidenceDepth": "deep", "project.evidenceChars": 9_000_000 }, true)))
      .toMatchObject({ maxEvidenceChars: 900_000 });
  });

  it("carries an explicit evidence scope so a reader can replace the built-in globs", async () => {
    const { projectEvidenceLimits } = await import("../src/projectAiLimits.js");
    expect(projectEvidenceLimits(configuration({ "project.evidenceInclude": [" src/** ", "", "docs/**"] })).include)
      .toEqual(["src/**", "docs/**"]);
    // A malformed value never becomes a scope.
    expect(projectEvidenceLimits(configuration({ "project.evidenceInclude": "src/**" })).include).toEqual([]);
  });

  it("widens the prompt budget with the evidence budget so raising one never strands the other", async () => {
    const { projectAiLimits } = await import("../src/projectAiLimits.js");
    expect(projectAiLimits(configuration({ "project.evidenceChars": 900_000 })).maxInputChars).toBe(1_060_000);
    // A small evidence budget never shrinks the prompt below the default headroom.
    expect(projectAiLimits(configuration({ "project.evidenceChars": 20_000 })).maxInputChars).toBe(400_000);
  });

  it("ignores values outside the documented ranges instead of forwarding them to the service", async () => {
    const { projectEvidenceLimits } = await import("../src/projectAiLimits.js");
    const limits = projectEvidenceLimits(configuration({
      "project.evidenceFiles": 0,
      "project.evidenceFileChars": 10,
      "project.evidenceChars": 5_000_000
    }));
    expect(limits).toEqual({ maxFiles: 600, maxSourceFiles: 600, maxFileChars: 16_000, maxEvidenceChars: 600_000, include: [], preset: "standard" });
  });
});
