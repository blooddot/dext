import { describe, expect, it, vi } from "vitest";
import { ProjectDiagramAdapterRegistry } from "../src/core/projectDiagramRegistry.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";
import type { DiagramAdapterArtifact, DiagramAdapterCapability, DiagramAdapterDocument, ProjectDiagramAdapter } from "../src/core/projectDiagramAdapter.js";
import { createDiagramSnapshot } from "../src/core/projectDiagramHistory.js";

const diagram: ProjectDiagram = {
  schemaVersion: 1, id: "project", title: "Project", kind: "architecture", version: 1, updatedAt: 1,
  nodes: [{ id: "app", label: "App", role: "system", semanticIds: [], evidence: [{ path: "src/app.ts", line: 1 }] }], relations: []
};

function fakeAdapter(id: string, options: { fail?: "transform" | "validate" | "render"; format?: "svg" | "html"; delay?: boolean } = {}): ProjectDiagramAdapter {
  const capability: DiagramAdapterCapability = { kind: "architecture", formats: [options.format ?? "svg"], features: ["deterministic", "validation"] };
  const pending = new Set<string>();
  const cancelSpy = vi.fn();
  const artifact = (document: DiagramAdapterDocument): DiagramAdapterArtifact => ({ format: options.format ?? "svg", mimeType: options.format === "html" ? "text/html" : "image/svg+xml", content: options.format === "html" ? "<html>ok</html>" : "<svg></svg>", adapterId: id, adapterVersion: "1", diagramId: document.diagramId });
  const adapter: ProjectDiagramAdapter = {
    id, version: "1", capabilities: [capability], supports: (kind) => kind === "architecture",
    transform: (value, signal) => {
      if (options.fail === "transform") return Promise.reject(new Error(`${id} transform failed`));
      if (!options.delay) return Promise.resolve({ adapterId: id, adapterVersion: "1", diagramId: value.id, kind: value.kind, payload: value });
      return new Promise<DiagramAdapterDocument>((resolve) => {
        const op = "pending"; pending.add(op);
        signal?.addEventListener("abort", () => { pending.delete(op); }, { once: true });
        void resolve;
      });
    },
    preview: (document: DiagramAdapterDocument) => Promise.resolve(artifact(document)),
    render: (document: DiagramAdapterDocument) => options.fail === "render" ? Promise.reject(new Error(`${id} render failed`)) : Promise.resolve(artifact(document)),
    export: (document: DiagramAdapterDocument) => Promise.resolve(artifact(document)),
    validate: () => options.fail === "validate" ? Promise.reject(new Error(`${id} validate failed`)) : Promise.resolve({ adapterId: id, adapterVersion: "1", status: "passed" as const, checkedAt: 1, issues: [] }),
    cancel: cancelSpy, dispose: vi.fn()
  };
  Object.defineProperty(adapter, "pending", { value: pending });
  Object.defineProperty(adapter, "cancelSpy", { value: cancelSpy });
  return adapter;
}

describe("ProjectDiagramAdapterRegistry", () => {
  it("retains defaults while allowing serializable per-kind and per-diagram overrides", () => {
    const registry = new ProjectDiagramAdapterRegistry();
    registry.setPreference("architecture", "drawio");
    registry.setDiagramPreference("project", "archify");
    const state = registry.exportPreferences();
    expect(state).toEqual({ schemaVersion: 1, byKind: { architecture: "drawio" }, byDiagram: { project: "archify" } });
    const restored = new ProjectDiagramAdapterRegistry();
    restored.importPreferences(state);
    expect(restored.preference("architecture")).toBe("drawio");
    expect(restored.diagramPreference("project")).toBe("archify");
    expect(restored.choices("workflow")[0]?.reason).toContain("not installed");
  });

  it("falls through a failing preferred adapter and reports the successful fallback", async () => {
    const registry = new ProjectDiagramAdapterRegistry();
    registry.register(fakeAdapter("primary", { fail: "transform" }));
    registry.register(fakeAdapter("secondary"));
    const result = await registry.render(diagram, { adapterId: "primary" });
    expect(result.status).toBe("rendered");
    expect(result.adapterId).toBe("secondary");
    expect(result.fallback).toBe(true);
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(["failed", "unsupported", "unsupported", "unsupported", "rendered"]);
  });

  it("preserves a validated previous artifact when every replacement fails", async () => {
    const registry = new ProjectDiagramAdapterRegistry();
    const failing = fakeAdapter("primary", { fail: "render" });
    registry.register(failing);
    const previousArtifact: DiagramAdapterArtifact = { format: "svg", mimeType: "image/svg+xml", content: "<svg previous/>" , adapterId: "primary", adapterVersion: "1", diagramId: diagram.id };
    const previous = createDiagramSnapshot(diagram, previousArtifact, { adapterId: "primary", adapterVersion: "1", status: "passed", checkedAt: 1, issues: [] }, { renderedAt: 1 });
    const result = await registry.render(diagram, { adapterId: "primary", previous });
    expect(result.status).toBe("failed");
    expect(result.usedLastGood).toBe(true);
    expect(result.artifact?.content).toBe("<svg previous/>");
    expect(result.snapshot?.artifact.adapterId).toBe("primary");
  });

  it("cancels a hanging adapter and does not promote its late result", async () => {
    const registry = new ProjectDiagramAdapterRegistry();
    const hanging = fakeAdapter("hanging", { delay: true });
    registry.register(hanging);
    const controller = new AbortController();
    const promise = registry.render(diagram, { adapterId: "hanging", operationId: "op", signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect((hanging as ProjectDiagramAdapter & { cancelSpy: ReturnType<typeof vi.fn> }).cancelSpy).toHaveBeenCalledWith("op");
    expect(result.snapshot).toBeUndefined();
  });
});
