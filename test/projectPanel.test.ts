import { describe, expect, it } from "vitest";
import { projectObjectSchema } from "../src/features/project/contracts/projectKnowledge.js";
import type { ProjectInitializationState } from "../src/features/project/host/projectService.js";
import { renderProjectPanel, type ProjectPanelData } from "../src/features/project/presentation/projectPanel.js";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";
import { renderProjectMarkdown } from "../src/features/project/presentation/projectMarkdown.js";
import { readerIntroduction } from "../src/features/project/presentation/projectTopicsView.js";
import { buildProjectTopics, topicFingerprint } from "../src/features/project/knowledge/projectTopics.js";
import { projectModelIntent } from "../src/features/project/knowledge/projectModel.js";

const initialization = (status: ProjectInitializationState["status"], extra: Partial<ProjectInitializationState> = {}): ProjectInitializationState => ({ status, ...extra });

const data = (overrides: Partial<ProjectPanelData> = {}, state: ProjectInitializationState = initialization("uninitialized")): ProjectPanelData => ({
  overview: { name: "Fixture", root: "C:/ws", objects: 0, accepted: 0, drafts: 0, needsVerification: 0, initialization: state },
  objects: [],
  architecture: { diagrams: [] },
  ...overrides
});

describe("project panel", () => {
  const model = projectModelSchema.parse({ schemaVersion: 1, revision: 7, updatedAt: 0, nodes: [
    { id: "module", kind: "module", title: "Renderer <entry>", canonicalName: "Renderer", body: { kind: "inline", text: "## Responsibility\n\n- **Render** `src/entry.ts`\n\n| Field | Value |\n| --- | --- |\n| Mode | read |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))" } },
    { id: "document", kind: "architecture", title: "Architecture", canonicalName: "Architecture", body: { kind: "document", path: "docs/architecture.md", contentHash: "saved" } }
  ], relations: [{ id: "relation", from: "module", to: "document", kind: "depends_on" }] });

  it("renders normative Markdown end to end without enabling raw HTML or unsafe links", () => {
    const topics = buildProjectTopics(projectModelIntent(model));
    const html = renderProjectPanel("knowledge", data({ model, knowledge: { topics } })).split("<script>")[0]!;
    expect(html).toContain("<h2>Responsibility</h2>");
    expect(html).toContain("<strong>Render</strong>");
    expect(html).toContain("<code>src/entry.ts</code>");
    expect(html).toContain("<table>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("data-native-knowledge");
    expect(renderProjectMarkdown("# Title")).toBe("<h2>Title</h2>\n");
  });

  it("folds a norm's maintenance into the article that renders it, and nothing else", () => {
    const topics = buildProjectTopics(projectModelIntent(model));
    const html = renderProjectPanel("knowledge", data({ model, knowledge: { topics } })).split("<script>")[0]!;
    // The model node `module` is a topic, so its controls sit in its own article.
    expect(html).toContain('data-norm="module"');
    expect(html).toContain('data-knowledge-save="module"');
    expect(html).toContain('data-knowledge-confirm="module"');
    expect(html).toContain('data-knowledge-unlink="relation"');
    expect(html).toContain("Renderer &lt;entry&gt; → Architecture");
    expect(html).toContain("data-knowledge-link");
    // Nodes without an article are maintained from the introduction, never on a second page.
    const introduction = readerIntroduction({ model, topics, checks: [], diagrams: [], brief: "", gallery: false });
    expect(introduction).toContain('data-norm="document"');
    expect(introduction).toContain('data-knowledge-open="document"');
    expect(introduction).toContain('data-knowledge-adopt="document"');
    expect(introduction).toContain("Project norms");
    expect(introduction).not.toContain('data-norm="module"');
    expect(html).toContain('data-project-page="knowledge" aria-selected="true"');
    expect(html).not.toContain('data-project-page="specs"');
    // A reopened norm block stays open after its own write re-renders the page.
    expect(renderProjectPanel("knowledge", data({ model, knowledge: { topics } }), { state: { key: "dext.editor:project", page: "knowledge", filters: { spec: "module" }, restoreVersion: 1 } }))
      .toContain('data-norm="module" open');
  });
  it("shows persisted semantic review warnings and escapes source-derived messages", () => {
    const html = renderProjectPanel('overview', data({ overview: { ...data().overview,
      qualityIssues: [{ code: 'missing-context-mapping', message: 'Webview <entry> needs a knowledge link', contextIds: [], elementIds: [], sourcePaths: [] }] } }));
    expect(html).toContain('Architecture issues · 1');
    expect(html).toContain('Webview &lt;entry&gt; needs a knowledge link');
  });
  it("shows an explicit uninitialized state with a deliberate initialization entry", () => {
    const html = renderProjectPanel("overview", data());
    expect(html).toContain('data-project-initialization-state="uninitialized"');
    expect(html).toContain("data-project-initialize");
    expect(html).toContain("Build project model");
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

  it("guides missing evidence configuration and accepts saved empty scope", () => {
    const overview = {
      ...data().overview,
      workspaceSettings: { planDirectory: ".dext/plans", apiDirs: [], skillDirs: [], mcpDirs: [] },
      evidenceSettings: { depth: "standard" as const, include: [] }
    };
    const missing = renderProjectPanel("overview", data({ overview: { ...overview, evidenceConfigured: false } })).split("<script>")[0]!;
    expect(missing).toContain("data-project-evidence-required");
    expect(missing).toContain('data-evidence-configured="false"');
    expect(missing).toContain("Save reading settings");
    const configured = renderProjectPanel("overview", data({ overview: { ...overview, evidenceConfigured: true } })).split("<script>")[0]!;
    expect(configured).not.toContain("data-project-evidence-required");
    expect(configured).not.toContain("Save reading settings");
    expect(configured).toContain('data-evidence-configured="true"');
  });

  it("distinguishes running, failed, cancelled and completed-but-missing-diagram states", () => {
    const running = renderProjectPanel("overview", data({}, initialization("running", { phase: "generating", percent: 63, message: "generating" })));
    expect(running).toContain("project-init-running");
    expect(running).toContain('value="63"');
    expect(running).toContain("63%");
    expect(running).toContain("data-project-initialize-pause");
    expect(running).toContain(">Pause<");
    // Saving may already have written artifacts, so it no longer offers Pause.
    const saving = renderProjectPanel("overview", data({}, initialization("running", { phase: "saving", percent: 92 }))).split("<script>")[0]!;
    expect(saving).not.toContain("data-project-initialize-pause");

    const failed = renderProjectPanel("overview", data({}, initialization("failed", { error: "AI unavailable" })));
    expect(failed).toContain("AI unavailable");
    expect(failed).toContain("Retry initialization");

    const cancelled = renderProjectPanel("overview", data({}, initialization("cancelled")));
    expect(cancelled).toContain("Initialization stopped");
    expect(cancelled).toContain("Continue initialization");
    expect(cancelled).not.toContain("Retry initialization");

    const paused = renderProjectPanel("overview", data({}, initialization("cancelled", { resumable: true, resumeStage: "batches", resumePercent: 52 })));
    expect(paused).toContain("Initialization paused after responsibility batches (52%)");
    expect(paused).toContain("Resume initialization");

    const completed = renderProjectPanel("overview", data({}, initialization("completed", { phase: "saving", intentGenerated: true, diagramsGenerated: 0 })));
    expect(completed).toContain('data-project-initialization-state="completed"');
    expect(completed).toContain("Analyze this module");

    const resumableCompleted = renderProjectPanel("overview", data({}, initialization("completed", {
      phase: "saving", intentGenerated: true, resumable: true, resumeStage: "batches", resumePercent: 53
    })));
    expect(resumableCompleted).toContain("An earlier update stopped after responsibility batches (53%)");
    expect(resumableCompleted).toContain("Update project model");
  });

  it("opens saved diagrams inside the reader without a separate primary tab", () => {
    const kinds = ["architecture", "workflow", "sequence", "data_flow", "lifecycle", "tree", "class"] as const;
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
