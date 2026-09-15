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

  it("keeps the initialization progress indicator visible after a page refresh", () => {
    const html = renderProjectPanel("overview", {
      ...data,
      overview: {
        ...data.overview,
        initialization: { status: "running", aiAvailable: true, scannedFiles: 7, phase: "generating", progress: 1, progressTotal: 3 }
      }
    });
    expect(html).toContain("project-scan-progress-running");
    expect(html).toContain("Initializing project knowledge");
    expect(html).toContain("7 files scanned");
    expect(html).toContain('aria-valuenow="1"');
    expect(html).toContain("1/3");
    expect(html).not.toContain('class="project-initialize"');
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
    // The panel root also has data-project-page; only tab buttons may trigger
    // navigation so native selects remain open long enough to choose an option.
    expect(html).toContain('button[data-project-page]');
    // The client never requests conversation runs or Hook output.
    expect(html).not.toContain("review");
  });

  it("renders the project AI CLI selector and forwards changes", () => {
    const html = renderProjectPanel("overview", {
      ...data,
      overview: {
        ...data.overview,
        aiCli: [{ id: "codex", label: "Codex CLI" }, { id: "claude", label: "Claude CLI" }],
        selectedAiCli: "claude"
      }
    });
    expect(html).toContain('data-project-ai-cli');
    expect(html).toContain('value="claude" selected');
    expect(html).toContain("type:'projectAiCli'");
  });

  it("renders models for the selected project AI CLI", () => {
    const html = renderProjectPanel("overview", {
      ...data,
      overview: {
        ...data.overview,
        aiCli: [{ id: "codex", label: "Codex CLI", models: [{ id: "o4-mini", label: "o4-mini" }] }],
        selectedAiCli: "codex",
        selectedAiModel: "o4-mini"
      }
    });
    expect(html).toContain('data-project-ai-model');
    expect(html).toContain('composer-model-popover');
    expect(html).toContain('composer-menu-category');
    expect(html).toContain('data-project-model-submenu');
    expect(html).toContain('value="o4-mini" selected');
    expect(html).toContain("type:'projectAiModel'");
  });

  it("shows Input model capabilities below the project model selector", () => {
    const html = renderProjectPanel("overview", {
      ...data,
      overview: {
        ...data.overview,
        aiCli: [{ id: "codex", label: "Codex CLI", models: [{
          id: "o4", label: "o4", reasoningEfforts: ["medium", "high"], speedTiers: ["standard", "fast"]
        }] }],
        selectedAiCli: "codex",
        selectedAiModel: "o4"
      }
    });
    expect(html).toContain("Reasoning: medium / high");
    expect(html).toContain("Speed: standard / fast");
    expect(html).toContain("project-model-capabilities");
    expect(html).toContain("data-project-ai-model-details");
  });

  it("marks and scrolls to the object an adopted suggestion wrote", () => {
    const html = renderProjectPanel("knowledge", data, { focusObjectId: "TaskQuery" });
    expect(html).toContain('data-project-focus="TaskQuery"');
    expect(html).toContain("project-object-focus");
    // Without a focus the page is unchanged, so a plain navigation stays quiet.
    expect(renderProjectPanel("knowledge", data)).not.toContain('data-project-focus="');
  });

  it("renders semantic knowledge sections when supplied", () => {
    const html = renderProjectPanel("knowledge", {
      ...data,
      knowledge: {
        brief: "A task management workspace.",
        contexts: [{ id: "ctx-tasks", name: "Task management", description: "Owns task state." }],
        terms: [{ id: "term-task", canonical: "Task", aliases: ["Work item"], definition: "A unit of work." }],
        flows: [{ id: "flow-create", name: "Create task", steps: ["Validate input", "Persist task"] }],
        evidence: [{ id: "ev-1", path: "src/tasks.ts", line: 4 }]
      }
    });
    expect(html).toContain("Project Brief");
    expect(html).toContain("Task management");
    expect(html).toContain("Work item");
    expect(html).toContain("Create task");
    expect(html).toContain("src/tasks.ts:4");
  });

  it("renders adapter controls and explicit diagram actions", () => {
    const html = renderProjectPanel("architecture", {
      ...data,
      architecture: {
        ...data.architecture,
        diagramKind: "architecture",
        adapter: {
          currentId: "structurizr",
          choices: [
            { id: "structurizr", version: "1", available: true, supported: true, preferred: true, formats: ["structurizr"] },
            { id: "mermaid", available: true, supported: false, preferred: false, formats: ["mermaid"], reason: "No interactive support" }
          ],
          fallback: ["structurizr", "archify", "drawio"],
          recommendation: "Use C4 for architecture overview."
        }
      }
    });
    expect(html).toContain("data-project-adapter-select");
    expect(html).toContain("Use recommended");
    expect(html).toContain("No interactive support");
    expect(html).toContain("projectAdapterPreference");
    expect(html).toContain("projectDiagramAction");
  });
});
