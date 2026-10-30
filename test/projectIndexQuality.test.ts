import { describe, expect, it } from "vitest";
import { projectIntentSchema, type ProjectQualityIssue } from "../src/features/project/contracts/projectIntent.js";
import { projectModelQuality, withProjectQuality } from "../src/features/project/host/generation/projectModelQuality.js";
import type { StructureMember } from "../src/features/project/host/indexing/projectStructure.js";
import { responsibilityContext } from "../src/features/project/host/indexing/projectStructureKnowledge.js";
import { buildProjectTopics } from "../src/features/project/knowledge/projectTopics.js";
import { parseProjectModel, projectModelIntent } from "../src/features/project/knowledge/projectModel.js";
import { renderProjectQuality } from "../src/features/project/presentation/projectTopicsView.js";

describe("ownership review classification", () => {
  it.each(["apiEditorProvider", "editorTabHtml", "agentSelectionDefaults", "fileSearch", "apiPanel", "unfamiliarHelper"])("keeps justified %s boundaries without a filename whitelist", name => {
    const member = (path: string, dependencies: StructureMember["dependencies"] = []): StructureMember => ({ path, hash: "h", language: "typescript", lines: 1, symbols: [], dependencies });
    const helper = member(`src/${name}.ts`), peer = member("src/peer.ts"), caller = member("src/composition.ts", [{ specifier: `./${name}`, to: helper.path }]);
    const contexts = [responsibilityContext("Feature", "Own the feature", [helper, peer], [helper.path]), responsibilityContext("Composition", "Connect features", [caller], [caller.path])];
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 0, brief: { name: "App", summary: "App" }, contexts });
    const initial = projectModelQuality(intent, [helper, peer, caller]);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.status).toBe("unresolved");
    const reviewed: ProjectQualityIssue = { ...initial[0]!, status: "retained", reason: "The composition root installs this independently owned feature.", evidence: [{ path: helper.path }, { path: caller.path }] };
    intent.qualityIssues = projectModelQuality(intent, [helper, peer, caller], [reviewed]);
    const topic = buildProjectTopics(intent).find(item => item.id === contexts[0]!.id)!;
    expect(topic.qualityWarnings).toEqual([]);
    expect(topic.qualityIssues?.[0]?.reason).toContain("composition root");
    const html = renderProjectQuality(intent.qualityIssues, topic);
    expect(html).toContain("Explained ownership decisions");
    expect(html).toMatch(/<details class="project-quality project-quality-decided"><summary/);
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);
    expect(html).toContain("data-topic-evidence");
    // Each issue carries its own copy action; a group action only appears for several issues.
    expect(html.match(/data-project-quality-copy=/g)).toHaveLength(1);
    expect(html).not.toContain("Copy all");
    // Old data has no review decision; loading it must not imply approval.
    const legacy = { ...reviewed };
    delete legacy.status; delete legacy.reason; delete legacy.evidence;
    expect(renderProjectQuality([legacy])).toContain("Ownership needs review");
    expect(renderProjectQuality([legacy, { ...legacy, message: "Second concern" }])).toContain("Copy all 2");
  });
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
