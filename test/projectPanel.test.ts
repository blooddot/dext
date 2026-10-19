import { describe, expect, it } from "vitest";
import { renderProjectPanel, type ProjectPanelData } from "../src/webview/projectPanel.js";
import { projectObjectSchema } from "../src/core/projectKnowledge.js";
import type { ProjectInitializationState } from "../src/projectService.js";

const initialization = (status: ProjectInitializationState["status"], extra: Partial<ProjectInitializationState> = {}): ProjectInitializationState => ({ status, ...extra });

const data = (overrides: Partial<ProjectPanelData> = {}, state: ProjectInitializationState = initialization("uninitialized")): ProjectPanelData => ({
  overview: { name: "Fixture", root: "C:/ws", objects: 0, accepted: 0, drafts: 0, needsVerification: 0, initialization: state },
  objects: [],
  architecture: { diagrams: [] },
  ...overrides
});

describe("project panel", () => {
  it("shows persisted semantic review warnings and escapes source-derived messages", () => {
    const html = renderProjectPanel('overview', data({ overview: { ...data().overview,
      qualityIssues: [{ code: 'missing-context-mapping', message: 'Webview <entry> needs a knowledge link', contextIds: [], elementIds: [], sourcePaths: [] }] } }));
    expect(html).toContain('1 quality checks to review');
    expect(html).toContain('Webview &lt;entry&gt; needs a knowledge link');
  });
  it("shows an explicit uninitialized state with a deliberate initialization entry", () => {
    const html = renderProjectPanel("overview", data());
    expect(html).toContain('data-project-initialization-state="uninitialized"');
    expect(html).toContain("data-project-initialize");
    expect(html).toContain("Build project index");
    expect(html).not.toContain("data-project-choose-roots");
    expect(html).not.toContain("Choose scan folders");
    expect(html).not.toContain("code-derived");
    expect(html).not.toContain("Language");
  });

  it("renders project-owned plan, API and Skill settings without Review", () => {
    const html = renderProjectPanel("overview", data({ overview: {
      ...data().overview,
      workspaceSettings: { planDirectory: ".project/plans", apiDirs: ["tools/api", "tools/api/team"], skillDirs: ["tools/skills"], mcpDirs: ["tools/mcp"] },
      evidenceSettings: { depth: "standard", include: [] },
      workspaceSettingsVersion: 4
    } }));
    expect(html).toContain('data-project-settings');
    expect(html).toContain('value=".project/plans"');
    expect(html).toContain('value=".dext/api, tools/api, tools/api/team"');
    expect(html).toContain('value=".dext/skills, tools/skills"');
    expect(html).toContain('value=".dext/mcp, tools/mcp"');
    expect(html).toContain("API directories");
    expect(html).toContain("Skill directories");
    expect(html).toContain("MCP directories");
    expect(html).not.toContain("Additional project");
    expect(html).not.toContain('name="reviewPreset"');
    expect(html).not.toContain("Default Review");
    expect(html).toContain('data-version="4"');
    expect(html).toContain("Click to expand");
    expect(html).toContain("File limits and scope patterns");
    expect(html).not.toContain("Add directory");
    expect(html).not.toContain("data-project-directory-remove");
    expect(html).toContain('.split(",")');
  });

  it("shows the built-in resource directories when no project overrides are saved", () => {
    const html = renderProjectPanel("overview", data({ overview: {
      ...data().overview,
      workspaceSettings: { planDirectory: ".dext/plans", apiDirs: [], skillDirs: [], mcpDirs: [] },
      evidenceSettings: { depth: "standard", include: [] },
      workspaceSettingsVersion: 1
    } }));
    expect(html).toContain('value=".dext/api"');
    expect(html).toContain('value=".dext/skills"');
    expect(html).toContain('value=".dext/mcp"');
  });

  it("tells the reader when a removed scan profile is still sitting in .dext/project.json", () => {
    const clear = renderProjectPanel("overview", data());
    expect(clear.split("<script>")[0]).not.toContain("data-project-legacy-scan");

    const note = renderProjectPanel("overview", data({
      overview: { ...data().overview, legacyScanRoots: ["src", "lib"] }
    }));
    expect(note).toContain("data-project-legacy-scan");
    expect(note).toContain("scan");
    // The notice states the exact scope the retired roots still apply, not just that they exist.
    expect(note).toContain("<code>src/**</code>");
    expect(note).toContain("<code>lib/**</code>");
    expect(note).toContain("Project settings below");
    // The roots come from a project file, so they are escaped like any other untrusted value.
    const escaped = renderProjectPanel("overview", data({
      overview: { ...data().overview, legacyScanRoots: ["<img src=x onerror=1>"] }
    }));
    expect(escaped).not.toContain("<img src=x");
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
    expect(completed).toContain("Analyze this module");
  });

  it("opens saved diagrams inside the reader without a separate primary tab", () => {
    const kinds = ["architecture", "workflow", "sequence", "data_flow", "lifecycle"] as const;
    const diagrams = kinds.map((kind) => ({ schemaVersion: 1 as const, id: kind, title: `${kind} title`, kind, version: 1, updatedAt: 1, nodes: [], relations: [] }));
    const html = renderProjectPanel("architecture", data({ readerDiagrams: diagrams, architecture: { diagrams, selected: diagrams[0]! } }));
    expect(html).toContain("data-project-reader");
    expect(html).toContain("data-reader-view");
    expect(html).toContain("data-reader-export");
    expect(html).toContain("data-reader-fullscreen");
    expect(html).toContain("All saved diagrams");
    for (const kind of kinds) expect(html).toContain(`data-reader-diagram="${kind}"`);
    expect(html).not.toContain("data-diagram-frame");
    expect(html).not.toContain('role="tab" data-project-page="architecture"');
  });

  it("explains how to initialize an empty reader", () => {
    const html = renderProjectPanel("architecture", data());
    expect(html).toContain("Initialize the project from Overview");
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
    const html = renderProjectPanel("knowledge", { ...data(), objects: [object] }, { focusObjectId: object.id });
    // Saved object state and reference navigation remain available.
    expect(html).toContain(`data-object-id="${object.id}"`);
    expect(html).not.toContain("data-draft-action");
    expect(html).not.toContain("projectDraft");
    expect(html).not.toContain("Pending knowledge suggestions");
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
    expect(html).toContain(JSON.stringify(state));
    expect(html).toContain("api.getState&&api.getState()");
    // Pages rendered without a key (tests, previews) must not claim a state they cannot identify.
    expect(renderProjectPanel("overview", data())).not.toContain("api.setState(");
  });
});
