import { describe, expect, it } from "vitest";
import { projectImpactSchema, projectReviewReportSchema } from "../src/shared/contracts/planProject.js";
import { parseProjectImpact, planSemanticContent } from "../src/features/project/knowledge/projectPlan.js";

const impact = { assessment: "none", reason: "Implementation follows the contract", refs: ["contract"], coverage: "complete" };
const summary = `<!-- dext-project-impact: ${JSON.stringify(impact)} -->`;

describe("Project impact protocol", () => {
  it("distinguishes missing, invalid and justified none", () => {
    expect(parseProjectImpact("# Existing plan")).toEqual({ status: "missing" });
    expect(parseProjectImpact(summary)).toEqual({ status: "parsed", impact });
    const withCode = { ...impact, reason: "Preserve `greet()`" };
    expect(parseProjectImpact(`<!-- dext-project-impact: ${JSON.stringify(withCode, null, 4)} -->`)).toEqual({ status: "parsed", impact: withCode });
    for (const text of ["<!-- dext-project-impact: {} -->", "<!-- dext-project-impact:", summary + summary]) {
      expect(parseProjectImpact(text).status).toBe("invalid");
    }
  });
  it.each(["none", "change", "unknown", "conflict"])("accepts %s with a reason", assessment => {
    expect(projectImpactSchema.safeParse({ ...impact, assessment }).success).toBe(true);
  });
  it("does not treat no matches or incomplete coverage as no impact", () => {
    expect(projectImpactSchema.safeParse({ ...impact, refs: [] }).success).toBe(false);
    expect(projectImpactSchema.safeParse({ ...impact, coverage: "partial" }).success).toBe(false);
    expect(projectImpactSchema.safeParse({ ...impact, basis: [], workspaceKey: "forged" }).success).toBe(false);
  });
  it("ignores fenced, nested fenced, indented and inline examples", () => {
    for (const example of [`\`\`\`json\n${summary}\n\`\`\``, `~~~~\n~~~\n${summary}\n~~~~`, `    ${summary}`, `\`${summary}\``]) {
      expect(parseProjectImpact(example)).toEqual({ status: "missing" });
    }
    expect(parseProjectImpact(`\`\`\`\n${summary}\n\`\`\`\n${summary}`).status).toBe("parsed");
  });
  it("keeps task and code semantics while excluding progress and host comments", () => {
    const source = "# Plan\n1. [ ] Work; verify: test\n```\n1. [x] Example\n```";
    expect(planSemanticContent(source.replace("1. [ ] Work", "1. [x] Work") + "\n" + summary)).toBe(planSemanticContent(source));
    expect(planSemanticContent(source.replace("Work;", "Other;"))).not.toBe(planSemanticContent(source));
    expect(planSemanticContent(source.replace("[x] Example", "[ ] Example"))).not.toBe(planSemanticContent(source));
  });
  it("rejects a contradictory final report", () => {
    const report = { ...impact, checks: [{ source: "host_observed", description: "Content baseline", status: "passed" }], projectDelta: [] };
    expect(projectReviewReportSchema.safeParse(report).success).toBe(true);
    expect(projectReviewReportSchema.safeParse({ ...report, projectDelta: [{ op: "create", target: "contract", id: "x", beforeHash: null, after: {}, evidence: ["src/a.ts"] }] }).success).toBe(false);
  });
});
