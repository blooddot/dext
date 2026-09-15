import { describe, expect, it } from "vitest";
import { evaluateArchitectureRules, type ArchitectureScanResult } from "../src/core/projectArchitecture.js";
import { scanProjectArchitecture } from "../src/core/projectArchitectureScanner.js";
import { runArchitectureScan } from "../src/core/projectArchitectureWorker.js";

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
