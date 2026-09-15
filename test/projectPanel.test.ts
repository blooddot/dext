import { describe, expect, it } from "vitest";
import { projectObjectSchema } from "../src/core/projectKnowledge.js";
import { PROJECT_PANEL_PAGES, renderProjectPanel, type ProjectPanelData } from "../src/webview/projectPanel.js";
import { relationSourceLabel } from "../src/webview/projectArchitectureView.js";

const object = projectObjectSchema.parse({
  id: "TaskQuery", canonicalName: "TaskQuery", displayName: "任务查询", kind: "feature",
  source: "user", confirmation: "accepted", validity: "needs_verification", description: "Runs a query."
});

const data: ProjectPanelData = {
  overview: {
    name: "Fixture", root: "C:/ws", languages: ["typescript", "python", "rust"],
    objects: 1, accepted: 1, drafts: 0, needsVerification: 1,
    initialization: { status: "completed", aiAvailable: true, scannedFiles: 12 }
  },
  objects: [object],
  drafts: [{ id: "d1", kind: "update", proposed: { description: "draft" }, evidence: [], reason: "AI saw a change", source: "ai", baseVersion: 1 }],
  architecture: {
    modules: [{ id: "src/app", name: "app", language: "typescript", paths: ["src/app.ts"], source: "detected" }],
    relations: [
      { from: "src/app", to: "src/lib", source: "detected", confidence: 1, file: "src/app.ts", line: 2 },
      { from: "ui/index", to: "tauri/commands", source: "declared", confidence: 1, reason: "Tauri IPC contract" }
    ],
    rules: [{ id: "no-ui-db", type: "deny", from: "ui", to: "db" }],
    decisions: [{ id: "d1", title: "Local SVG", detail: "Rendered without a browser address." }]
  }
};

describe("project panel", () => {
  it("exposes only Overview, Knowledge, and Architecture", () => {
    expect(PROJECT_PANEL_PAGES).toEqual(["overview", "knowledge", "architecture"]);
    const html = renderProjectPanel("overview", data);
    expect(html).toContain('data-project-page="overview"');
    expect(html).not.toMatch(/data-project-page="(hooks|review|tasks|logs)"/);
  });

  it("never emits conversation runs, hook logs, or single-run Review", () => {
    const html = PROJECT_PANEL_PAGES.map((page) => renderProjectPanel(page, data)).join("\n");
    expect(html).not.toMatch(/data-project-section="(hooks|review|logs)"/);
    expect(html.toLowerCase()).not.toContain("execution log");
    expect(html.toLowerCase()).not.toContain("hook");
  });

  it("shows long-term knowledge with independent confirmation and validity", () => {
    const html = renderProjectPanel("knowledge", data);
    expect(html).toContain('data-object-id="TaskQuery"');
    expect(html).toContain('data-confirmation="accepted"');
    expect(html).toContain('data-validity="needs_verification"');
    expect(html).toContain("任务查询");
    expect(html).toContain('data-draft-action="accept"');
  });

  it("renders a local SVG and separates manual from static relations", () => {
    const html = renderProjectPanel("architecture", data);
    expect(html).toContain("<svg class=\"architecture-graph\"");
    expect(relationSourceLabel("declared")).toBe("Manual (declared)");
    expect(relationSourceLabel("detected")).toBe("Static detection");
    expect(html).toContain('data-source="declared"');
    expect(html).toContain('data-source="detected"');
    expect(html).toContain("Design decisions");
    expect(html).toContain("no-ui-db");
  });

  it("forwards page navigation and draft decisions to the host", () => {
    const html = renderProjectPanel("knowledge", data);
    expect(html).toContain("acquireVsCodeApi()");
    expect(html).toContain('type:"projectPage"');
    expect(html).toContain('type:"projectDraft"');
    // The client never requests conversation runs or Hook output.
    expect(html).not.toContain("review");
  });

  it("marks and scrolls to the object an adopted suggestion wrote", () => {
    const html = renderProjectPanel("knowledge", data, { focusObjectId: "TaskQuery" });
    expect(html).toContain('data-project-focus="TaskQuery"');
    expect(html).toContain("project-object-focus");
    // Without a focus the page is unchanged, so a plain navigation stays quiet.
    expect(renderProjectPanel("knowledge", data)).not.toContain('data-project-focus="');
  });
});
