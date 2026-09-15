import { describe, expect, it } from "vitest";
import type { DiagramValidationReceipt, ProjectDiagram } from "../src/core/projectDiagram.js";
import type { DiagramAdapterArtifact } from "../src/core/projectDiagramAdapter.js";
import { compareDiagramSnapshots, createDiagramSnapshot, ProjectDiagramHistory } from "../src/core/projectDiagramHistory.js";

const receipt: DiagramValidationReceipt = { adapterId: "test", adapterVersion: "1", status: "passed", checkedAt: 1, issues: [] };
const base: ProjectDiagram = {
  schemaVersion: 1, id: "demo", title: "Demo", kind: "architecture", version: 1, updatedAt: 1,
  nodes: [
    { id: "app", label: "App", role: "system", semanticIds: ["app"], evidence: [{ path: "src/app.ts", line: 1 }] },
    { id: "db", label: "DB", role: "store", semanticIds: ["db"], evidence: [{ path: "src/db.ts", line: 2 }] }
  ], relations: [{ id: "r", from: "app", to: "db", kind: "writes", evidence: [{ path: "src/app.ts", line: 4 }] }]
};
const artifact = (content: string): DiagramAdapterArtifact => ({ format: "svg", mimeType: "image/svg+xml", content, adapterId: "test", adapterVersion: "1", diagramId: "demo" });

describe("Project diagram history", () => {
  it("separates semantic, evidence, manual layout, rendered layout and artifact deltas", () => {
    const before = createDiagramSnapshot(base, artifact("<svg a/>"), receipt, {
      renderedAt: 1,
      layoutOverlay: { adapterId: "drawio", version: 1, updatedAt: 1, nodes: { app: { x: 0, y: 0 }, db: { x: 10, y: 10 } } },
      renderedLayout: { nodes: { app: { x: 0, y: 0 }, db: { x: 10, y: 10 } }, routes: { r: [{ x: 1, y: 1 }] } }
    });
    const afterDiagram: ProjectDiagram = {
      ...base, version: 2,
      nodes: [...base.nodes.map((node) => node.id === "app" ? { ...node, label: "Application", evidence: [{ path: "src/app.ts", line: 9 }] } : node), { id: "queue", label: "Queue", role: "event", semanticIds: [], evidence: [{ path: "src/queue.ts" }] }],
      relations: [...base.relations, { id: "r2", from: "app", to: "queue", kind: "publishes", evidence: [] }]
    };
    const after = createDiagramSnapshot(afterDiagram, artifact("<svg b/>"), receipt, {
      renderedAt: 2,
      layoutOverlay: { adapterId: "drawio", version: 2, updatedAt: 2, nodes: { app: { x: 5, y: 0 }, db: { x: 10, y: 10 } } },
      renderedLayout: { nodes: { app: { x: 5, y: 0 }, db: { x: 10, y: 10 } }, routes: { r: [{ x: 2, y: 2 }] } }
    });
    const comparison = compareDiagramSnapshots(before, after);
    expect(comparison.delta.semantic.nodes).toEqual({ added: ["queue"], removed: [], changed: ["app"] });
    expect(comparison.delta.semantic.relations.added).toEqual(["r2"]);
    expect(comparison.delta.evidence).toHaveLength(2);
    expect(comparison.delta.manualLayout.nodes.changed).toEqual(["app"]);
    expect(comparison.delta.renderedLayout.routes.changed).toEqual(["r"]);
    expect(comparison.delta.artifact.contentChanged).toBe(true);
    expect(comparison.delta.changed).toBe(true);
  });

  it("keeps the last-good snapshot when a failed render is recorded", () => {
    const history = new ProjectDiagramHistory();
    const snapshot = createDiagramSnapshot(base, artifact("<svg/>"), receipt, { renderedAt: 1 });
    history.record(snapshot);
    const failure: DiagramValidationReceipt = { adapterId: "test", adapterVersion: "1", status: "failed", checkedAt: 2, issues: [{ code: "layout", message: "bad layout", severity: "error" }] };
    history.recordFailure("demo", failure);
    expect(history.get("demo")?.lastGood.artifact.content).toBe("<svg/>");
    expect(history.get("demo")?.lastFailure?.status).toBe("failed");
  });

  it("rejects stale semantic versions and round-trips binary artifacts", () => {
    const history = new ProjectDiagramHistory(3);
    const first = createDiagramSnapshot(base, { ...artifact(""), format: "png", mimeType: "image/png", content: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) }, { ...receipt, adapterId: "test", }, { renderedAt: 5 });
    history.record(first);
    expect(() => history.record(createDiagramSnapshot({ ...base, version: 0 }, first.artifact, receipt, { renderedAt: 6 }))).toThrow("stale");
    const state = history.exportState();
    const restored = new ProjectDiagramHistory();
    restored.importState(state);
    expect(restored.get("demo")?.lastGood.artifact.content).toBeInstanceOf(Uint8Array);
    expect([...(restored.get("demo")?.lastGood.artifact.content as Uint8Array)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
