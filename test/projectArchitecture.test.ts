import { describe, expect, it } from "vitest";
import { evaluateArchitectureRules, type ArchitectureScanResult } from "../src/core/projectArchitecture.js";
import { scanProjectArchitecture } from "../src/core/projectArchitectureScanner.js";
import { runArchitectureScan } from "../src/core/projectArchitectureWorker.js";
import { renderArchitectureView } from "../src/webview/projectArchitectureView.js";

describe("architecture rules", () => {
  it("detects a cycle and denied relation", () => {
    const result: ArchitectureScanResult = { modules: [{ id: "a", name: "a", language: "typescript", paths: ["a.ts"], source: "detected" }, { id: "b", name: "b", language: "typescript", paths: ["b.ts"], source: "detected" }], relations: [{ from: "a", to: "b", source: "detected", confidence: 1 }, { from: "b", to: "a", source: "detected", confidence: 1 }], unsupported: [], parserVersions: {} };
    expect(evaluateArchitectureRules(result, [{ id: "cycle", type: "no_cycles", from: "*" }, { id: "deny", type: "deny", from: "a", to: "b" }])).toHaveLength(2);
  });
});

describe("architecture scan coverage", () => {
  const desktopProject = [
    { path: "native/Cargo.toml", content: '[package]\nname = "fixture"\nversion = "0.1.0"' },
    { path: "native/Cargo.lock", content: "# lockfile" },
    { path: "native/src/lib.rs", content: "pub fn run() {}" },
    { path: "native/src/tasks.rs", content: "use fixture::run;" },
    { path: "src/ui/Dashboard.tsx", content: 'import { api } from "../api.js";' },
    { path: "src/api.ts", content: "export const api = 1;" }
  ];

  it("reads the Cargo manifest so a local crate path resolves in the real scan", () => {
    const result = scanProjectArchitecture(desktopProject);
    expect(result.relations.some((relation) => relation.from === "native/src/tasks" && relation.to === "native/src/lib")).toBe(true);
    // A manifest is scan context: it is never reported as an unsupported file.
    expect(result.unsupported.some((entry) => entry.path.endsWith("Cargo.toml"))).toBe(false);
    expect(result.coverage?.some((note) => note.includes("Cargo.lock was not resolved"))).toBe(true);
  });

  it("carries the manifest limitation into the worker coverage notes", () => {
    const outcome = runArchitectureScan(desktopProject, { maxFiles: 10, maxFileBytes: 4096 });
    expect(outcome.coverage.limitReached).toBe(false);
    expect(outcome.coverage.notes.some((note) => note.includes("Cargo.lock was not resolved"))).toBe(true);
    expect(new Set(outcome.result.modules.map((module) => module.language))).toEqual(new Set(["rust", "typescript"]));
  });
});

describe("semantic architecture controls", () => {
  it("uses stable module ids for search and adapter selection", () => {
    const html = renderArchitectureView({
      modules: [{ id: "ctx.tasks", name: "Tasks", language: "typescript", paths: ["src/tasks.ts"], source: "detected" }],
      relations: [],
      diagramKind: "architecture",
      adapter: {
        currentId: "structurizr",
        choices: [{ id: "structurizr", version: "1", available: true, supported: true, preferred: true, formats: ["structurizr"] }]
      }
    });
    expect(html).toContain('data-module-id="ctx.tasks"');
    expect(html).toContain("data-project-diagram-search");
    expect(html).toContain("data-project-adapter-select");
    expect(html).toContain("projectAdapterPreference");
    expect(html).toContain('data-project-diagram-action="fullscreen"');
    expect(html).toContain("requestFullscreen");
  });

  it("keeps the first and last map nodes inside the SVG viewport", () => {
    const modules = ["a", "b", "c", "d"].map((id) => ({
      id, name: id.toUpperCase(), language: "typescript" as const, paths: [`${id}.ts`], source: "detected" as const
    }));
    const html = renderArchitectureView({ modules, relations: [] });
    const viewBox = html.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
    expect(viewBox).not.toBeNull();
    const width = Number(viewBox?.[1]);
    const height = Number(viewBox?.[2]);
    for (const match of html.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)"/g)) {
      const x = Number(match[1]);
      const y = Number(match[2]);
      const nodeWidth = Number(match[3]);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + nodeWidth).toBeLessThanOrEqual(width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y + 36).toBeLessThanOrEqual(height);
    }
  });
});
