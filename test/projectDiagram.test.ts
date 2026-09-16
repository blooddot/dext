import { describe, expect, it } from "vitest";
import { validateProjectDiagram, validationStatus, type DiagramValidationReceipt, type ProjectDiagram } from "../src/core/projectDiagram.js";
import type { DiagramAdapterArtifact } from "../src/core/projectDiagramAdapter.js";
import { compareDiagramSnapshots, createDiagramSnapshot, isArchifySnapshot, ProjectDiagramHistory } from "../src/core/projectDiagramHistory.js";

const evidence = (path: string, line = 1) => [{ path, line }];
const base = (kind: ProjectDiagram["kind"]): ProjectDiagram => ({
  schemaVersion: 1, id: `demo-${kind}`, title: "Demo", kind, version: 1, updatedAt: 1,
  nodes: [
    { id: "a", label: "A", role: kind === "lifecycle" ? "state" : "service", semanticIds: [], evidence: evidence("src/a.ts") },
    { id: "b", label: "B", role: kind === "data_flow" ? "store" : "service", semanticIds: [], evidence: evidence("src/b.ts") }
  ],
  relations: [{ id: "r", from: "a", to: "b", kind: kind === "sequence" ? "calls" : kind === "lifecycle" ? "transitions" : "depends_on", evidence: evidence("src/r.ts") }]
});
const receipt: DiagramValidationReceipt = { adapterId: "archify", adapterVersion: "1", status: "passed", checkedAt: 1, issues: [] };
const artifact = (content: string): DiagramAdapterArtifact => ({ format: "html", mimeType: "text/html", content, adapterId: "archify", adapterVersion: "1", diagramId: "demo-architecture" });

describe("Project diagram semantics", () => {
  it("validates architecture boundaries, workflow lanes, sequence messages, data-flow stages and lifecycle states", () => {
    const architecture: ProjectDiagram = {
      ...base("architecture"),
      semantics: { boundaries: [{ id: "b1", label: "Backend", nodeIds: ["a", "b"], evidence: evidence("src/a.ts") }] }
    };
    expect(validateProjectDiagram(architecture).filter((issue) => issue.severity === "error")).toEqual([]);

    const workflow: ProjectDiagram = {
      ...base("workflow"),
      nodes: base("workflow").nodes.map((node) => ({ ...node, laneId: "lane" })),
      semantics: { lanes: [{ id: "lane", label: "Lane", evidence: evidence("src/a.ts") }] }
    };
    expect(validationStatus(validateProjectDiagram(workflow))).not.toBe("failed");
    const danglingLane = { ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, laneId: "missing" })) };
    expect(validateProjectDiagram(danglingLane).some((issue) => issue.code === "dangling_lane")).toBe(true);

    const sequence: ProjectDiagram = {
      ...base("sequence"),
      semantics: {
        participants: [{ nodeId: "a", order: 0 }, { nodeId: "b", order: 1 }],
        messages: [{ relationId: "r", order: 1, kind: "call", evidence: evidence("src/r.ts") }]
      }
    };
    expect(validateProjectDiagram(sequence).some((issue) => issue.severity === "error")).toBe(false);
    const danglingMessage = { ...sequence, semantics: { ...sequence.semantics, messages: [{ relationId: "missing", order: 1, kind: "call" as const, evidence: [] }] } };
    expect(validateProjectDiagram(danglingMessage).some((issue) => issue.code === "dangling_message_relation")).toBe(true);

    const dataFlow: ProjectDiagram = {
      ...base("data_flow"),
      nodes: base("data_flow").nodes.map((node, index) => ({ ...node, stageId: index === 0 ? "s1" : "s2" })),
      semantics: { stages: [{ id: "s1", label: "Source", order: 0, evidence: evidence("src/a.ts") }, { id: "s2", label: "Store", order: 1, evidence: evidence("src/b.ts") }] }
    };
    expect(validateProjectDiagram(dataFlow).some((issue) => issue.severity === "error")).toBe(false);
    const danglingStage = { ...dataFlow, nodes: dataFlow.nodes.map((node) => ({ ...node, stageId: "missing" })) };
    expect(validateProjectDiagram(danglingStage).some((issue) => issue.code === "dangling_stage")).toBe(true);

    const lifecycle: ProjectDiagram = {
      ...base("lifecycle"),
      semantics: {
        states: [{ nodeId: "a", kind: "initial", evidence: evidence("src/a.ts") }, { nodeId: "b", kind: "terminal", outcome: "success", evidence: evidence("src/b.ts") }],
        transitions: [{ relationId: "r", event: "finish", evidence: evidence("src/r.ts") }]
      }
    };
    expect(validateProjectDiagram(lifecycle).some((issue) => issue.severity === "error")).toBe(false);
    const noTerminal = { ...lifecycle, semantics: { states: [{ nodeId: "a", kind: "initial" as const, evidence: [] }] } };
    expect(validateProjectDiagram(noTerminal).some((issue) => issue.code === "missing_lifecycle_states")).toBe(true);
  });

  it("keeps legacy diagrams without semantics readable and ignores removed layout metadata", () => {
    const legacy = { ...base("architecture"), layoutOverlay: { adapterId: "drawio", nodes: { a: { x: 0, y: 0 } } } } as unknown as ProjectDiagram;
    const issues = validateProjectDiagram(legacy);
    expect(issues.some((issue) => issue.severity === "error")).toBe(false);
    expect(validationStatus(issues)).not.toBe("failed");
  });
});

describe("Project diagram history", () => {
  it("separates semantic, evidence, rendered layout and artifact deltas", () => {
    const before = createDiagramSnapshot(base("architecture"), artifact("<html a></html>"), receipt, {
      renderedAt: 1,
      renderedLayout: { nodes: { a: { x: 0, y: 0 }, b: { x: 10, y: 10 } }, routes: { r: [{ x: 1, y: 1 }] } }
    });
    const afterDiagram: ProjectDiagram = {
      ...base("architecture"), version: 2,
      nodes: [...base("architecture").nodes.map((node) => node.id === "a" ? { ...node, label: "Application", evidence: evidence("src/a.ts", 9) } : node)],
      relations: [...base("architecture").relations, { id: "r2", from: "b", to: "a", kind: "depends_on", evidence: [] }]
    };
    const after = createDiagramSnapshot(afterDiagram, artifact("<html b></html>"), receipt, {
      renderedAt: 2,
      renderedLayout: { nodes: { a: { x: 5, y: 0 }, b: { x: 10, y: 10 } }, routes: { r: [{ x: 2, y: 2 }] } }
    });
    const comparison = compareDiagramSnapshots(before, after);
    expect(comparison.delta.semantic.nodes.changed).toEqual(["a"]);
    expect(comparison.delta.semantic.relations.added).toEqual(["r2"]);
    expect(comparison.delta.evidence).toHaveLength(1);
    expect(comparison.delta.renderedLayout.routes.changed).toEqual(["r"]);
    expect(comparison.delta.artifact.contentChanged).toBe(true);
    expect(comparison.delta.changed).toBe(true);
    expect("manualLayout" in comparison.delta).toBe(false);
  });

  it("keeps the last-good snapshot when a failed render is recorded", () => {
    const history = new ProjectDiagramHistory();
    history.record(createDiagramSnapshot(base("architecture"), artifact("<html/>"), receipt, { renderedAt: 1 }));
    history.recordFailure("demo-architecture", { ...receipt, status: "failed", issues: [{ code: "layout", message: "bad layout", severity: "error" }] });
    expect(history.get("demo-architecture")?.lastGood.artifact.content).toBe("<html/>");
    expect(history.get("demo-architecture")?.lastFailure?.status).toBe("failed");
  });

  it("rejects stale versions and only restores matching Archify snapshots", () => {
    const history = new ProjectDiagramHistory(3);
    const first = createDiagramSnapshot(base("architecture"), artifact("<html/>"), receipt, { renderedAt: 5 });
    history.record(first);
    expect(() => history.record(createDiagramSnapshot({ ...base("architecture"), version: 0 }, first.artifact, receipt, { renderedAt: 6 }))).toThrow("stale");
    expect(isArchifySnapshot(first)).toBe(true);
    expect(isArchifySnapshot(first, { diagramId: "demo-architecture", version: 1 })).toBe(true);
    expect(isArchifySnapshot(first, { version: 2 })).toBe(false);
    expect(isArchifySnapshot({ ...first, artifact: { ...first.artifact, adapterId: "drawio" } })).toBe(false);
  });

  it("round-trips history including binary payloads", () => {
    const binary = { ...artifact(""), content: Uint8Array.from([137, 80, 78, 71]) };
    const history = new ProjectDiagramHistory(3);
    history.record(createDiagramSnapshot(base("architecture"), binary, receipt, { renderedAt: 5 }));
    const restored = new ProjectDiagramHistory();
    restored.importState(history.exportState());
    expect(restored.get("demo-architecture")?.lastGood.artifact.content).toBeInstanceOf(Uint8Array);
    expect([...(restored.get("demo-architecture")?.lastGood.artifact.content as Uint8Array)]).toEqual([137, 80, 78, 71]);
  });
});
