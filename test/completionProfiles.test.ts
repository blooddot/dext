import { describe, expect, it } from "vitest";
import { completionBudget, suffixEvidence } from "../src/core/completionProfiles.js";
import { DEFAULT_COMPLETION_SETTINGS } from "../src/core/completionProvider.js";
describe("completion profiles", () => {
  it("keeps user token ceilings and clamps learned changes", () => {
    expect(completionBudget({ ...DEFAULT_COMPLETION_SETTINGS, maxTokens: 16 }, { prefix: "x", suffix: "", singleLine: true }, 99)).toBe(16);
  });
  it("reports uncertain suffix evidence rather than promising FIM support", () => {
    expect(suffixEvidence(["enabled", "retries"])).toContain("observed suffix");
    expect(suffixEvidence(["", ""])).toBe("inconclusive");
    expect(suffixEvidence(["enabled", "enabled"])).toContain("not observed");
  });
});
