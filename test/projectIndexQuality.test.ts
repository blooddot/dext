import { describe, expect, it } from "vitest";
import type { ProjectQualityIssue } from "../src/features/project/contracts/projectIntent.js";
import { withProjectQuality } from "../src/features/project/host/generation/projectModelQuality.js";
import { parseProjectModel, projectModelIntent } from "../src/features/project/knowledge/projectModel.js";
import { renderProjectQuality } from "../src/features/project/presentation/projectTopicsView.js";

describe("project quality signals", () => {
  it("keeps review signals on the native model, so the reader sees them again", () => {
    const issue: ProjectQualityIssue = { code: "community-split", message: "Review <this> boundary", contextIds: ["ctx"], elementIds: [], sourcePaths: ["src/a.ts"] };
    const model = parseProjectModel({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [{ id: "project", kind: "project", title: "App", canonicalName: "App", body: { kind: "inline", text: "App" } }] });
    expect(projectModelIntent(withProjectQuality(model, [issue])).qualityIssues).toEqual([issue]);
    // A rerun that finds nothing clears the stale set instead of keeping it forever.
    expect(projectModelIntent(withProjectQuality(withProjectQuality(model, [issue]), [])).qualityIssues).toBeUndefined();
  });
  it("escapes review explanations while keeping model defects visible", () => {
    const issue: ProjectQualityIssue = { code: "isolated-c4-element", message: "<unit>", sourcePaths: [], contextIds: [], elementIds: ["reader"], reason: "<script>" };
    const html = renderProjectQuality([issue]);
    expect(html).toContain("Architecture issues");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
