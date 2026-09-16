import { describe, expect, it } from "vitest";
import { renderProjectPanel, type ProjectPanelData } from "../src/webview/projectPanel.js";
import { projectObjectSchema } from "../src/core/projectKnowledge.js";
import type { KnowledgeSuggestion } from "../src/core/projectKnowledgeReview.js";
import type { ProjectInitializationState } from "../src/projectService.js";

const initialization = (status: ProjectInitializationState["status"], extra: Partial<ProjectInitializationState> = {}): ProjectInitializationState => ({ status, drafts: 0, ...extra });

const data = (overrides: Partial<ProjectPanelData> = {}, state: ProjectInitializationState = initialization("uninitialized")): ProjectPanelData => ({
  overview: { name: "Fixture", root: "C:/ws", objects: 0, accepted: 0, drafts: 0, needsVerification: 0, initialization: state },
  objects: [],
  architecture: { diagrams: [] },
  ...overrides
});

describe("project panel", () => {
  it("shows an explicit uninitialized state with a deliberate initialization entry", () => {
    const html = renderProjectPanel("overview", data());
    expect(html).toContain('data-project-initialization-state="uninitialized"');
    expect(html).toContain("data-project-initialize");
    expect(html).toContain("Initialize project knowledge");
    expect(html).not.toContain("data-project-choose-roots");
    expect(html).not.toContain("Choose scan folders");
    expect(html).not.toContain("code-derived");
    expect(html).not.toContain("Language");
  });

  it("distinguishes running, failed, cancelled and completed-but-missing-diagram states", () => {
    const running = renderProjectPanel("overview", data({}, initialization("running", { phase: "generating", progress: 1, progressTotal: 2, message: "generating" })));
    expect(running).toContain("project-init-running");
    expect(running).toContain("1/2");

    const failed = renderProjectPanel("overview", data({}, initialization("failed", { error: "AI unavailable" })));
    expect(failed).toContain("AI unavailable");
    expect(failed).toContain("Retry initialization");

    const cancelled = renderProjectPanel("overview", data({}, initialization("cancelled")));
    expect(cancelled).toContain("Initialization cancelled");

    const completed = renderProjectPanel("overview", data({}, initialization("completed", { phase: "saving", intentGenerated: true, diagramsGenerated: 0 })));
    expect(completed).toContain('data-project-initialization-state="completed"');
    expect(completed).toContain("no diagram is saved yet");
  });

  it("keeps the diagrams page free of the removed multi-engine and self-drawn canvas controls", () => {
    const diagrams = [
      { id: "a", title: "Architecture", kind: "architecture" as const, version: 2, updatedAt: 1 },
      { id: "w", title: "Flow", kind: "workflow" as const, version: 1, updatedAt: 1 }
    ];
    const html = renderProjectPanel("architecture", data({ architecture: { diagrams, selected: diagrams[0]! } }));
    expect(html).toContain("data-diagram-select");
    expect(html).toContain("data-diagram-generate-new");
    expect(html).toContain("data-diagram-generate-update");
    expect(html).toContain('data-diagram-action="refresh"');
    expect(html).toContain('data-diagram-action="export"');
    expect(html).toContain('data-diagram-action="fullscreen"');
    expect(html).toContain("data-diagram-frame");
    expect(html).toContain("dext-diagram-command");
    expect(html).toContain("projectDiagramRender");
    expect(html).toContain("projectDiagramExport");
    expect(html).not.toContain("data-project-adapter-select");
    expect(html).not.toContain("Use recommended");
    expect(html).not.toContain("architecture-graph");
    expect(html).not.toContain(">Architecture</button>");
    expect(html).toContain(">Diagrams<");
  });

  it("explains that saved diagrams stay viewable while knowledge is uninitialized", () => {
    const html = renderProjectPanel("architecture", data({ architecture: { diagrams: [], knowledgeUninitialized: true } }));
    expect(html).toContain("Project knowledge is not initialized");
    expect(html).toContain("No diagram generated yet");
  });

  it("lists all five diagram kinds with their English labels", () => {
    const kinds = ["architecture", "workflow", "sequence", "data_flow", "lifecycle"] as const;
    const diagrams = kinds.map((kind, index) => ({ id: kind, title: `${kind} title`, kind, version: index + 1, updatedAt: index }));
    const html = renderProjectPanel("architecture", data({ architecture: { diagrams, selected: diagrams[0]! } }));
    for (const label of ["Architecture", "Workflow", "Sequence", "Data flow", "Lifecycle"]) expect(html).toContain(label);
  });

  it("updates the knowledge page copy to the explicit initialization flow", () => {
    const html = renderProjectPanel("knowledge", data());
    expect(html).toContain("Project knowledge is not initialized yet");
    expect(html).not.toContain("code-derived source areas");
  });

  it("keeps the knowledge page controls and the object focus marker", () => {
    const object = projectObjectSchema.parse({
      id: "TaskQuery", canonicalName: "TaskQuery", displayName: "任务查询", kind: "feature",
      source: "user", confirmation: "accepted", validity: "needs_verification", description: "Runs a query."
    });
    const suggestion: KnowledgeSuggestion = { id: "s1", objectId: object.id, kind: "update", proposed: { description: "Runs a query." }, evidence: [], reason: "More precise", source: "ai" };
    const html = renderProjectPanel("knowledge", { ...data(), objects: [object], drafts: [suggestion] }, { focusObjectId: object.id });
    // These markers are the page's contract with the host script; the assertions for them were
    // deleted with the old page tests while the controls stayed in the markup.
    expect(html).toContain(`data-object-id="${object.id}"`);
    expect(html).toContain("data-draft-action");
    expect(html).toContain("data-confirmation=");
    expect(html).toContain("data-validity=");
    expect(html).toContain(`data-project-focus="${object.id}"`);
    // The AI CLI selector is overview markup that only exists when the host supplies CLIs; asserting
    // it here keeps the check on the element rather than on the page script that queries it.
    const withCli = renderProjectPanel("overview", data({ overview: { ...data().overview, aiCli: [{ id: "codex", label: "Codex", models: [] }] } }));
    expect(withCli).toContain("data-project-ai-cli");
    expect(renderProjectPanel("overview", data())).not.toContain("<select data-project-ai-cli");
  });

  it("acquires the VS Code API once per document, however many page scripts are emitted", () => {
    const html = renderProjectPanel("architecture", data({ architecture: { diagrams: [] } }));
    const calls = [...html.matchAll(/acquireVsCodeApi\(\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    // A second unguarded call throws inside a VS Code webview, which would leave the diagram bridge
    // (registered by the later script) dead.
    for (const call of calls) {
      const prefix = html.slice(Math.max(0, call.index - 30), call.index).replace(/\s+/g, "");
      expect(prefix, `call at ${call.index}`).toContain("window.__dextApi=");
    }
  });

  it("persists its own tab state so a reload restores the same page", () => {
    const state = { key: "dext.editor:project", page: "architecture", filters: {}, restoreVersion: 1 };
    const html = renderProjectPanel("architecture", data(), { state });
    expect(html).toContain(`api.setState(${JSON.stringify(state)})`);
    // Pages rendered without a key (tests, previews) must not claim a state they cannot identify.
    expect(renderProjectPanel("overview", data())).not.toContain("api.setState(");
  });
});
