import { describe, expect, it } from "vitest";
import { projectDiagramRenderer, projectPlaybackSteps } from "../src/core/projectDiagramPresentation.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";

const flow = (): ProjectDiagram => ({ schemaVersion: 1, id: "flow", title: "Flow", kind: "workflow", version: 0, updatedAt: 1,
  nodes: ["c", "a", "b"].map(id => ({ id, label: id, role: "step", semanticIds: [], evidence: [] })),
  relations: [{ id: "ab", from: "a", to: "b", kind: "calls", evidence: [] }, { id: "bc", from: "b", to: "c", kind: "calls", evidence: [] }]
});

describe("Project diagram presentation", () => {
  it("plays explicit connected order, independent of node array order", () => {
    expect(projectPlaybackSteps(flow()).map(step => step.id)).toEqual(["a", "b", "c"]);
  });
  it("does not fabricate a path for branches, cycles or disconnected nodes", () => {
    const branch = flow(); branch.relations = [...branch.relations, { id: "ac", from: "a", to: "c", kind: "calls", evidence: [] }];
    expect(projectPlaybackSteps(branch)).toEqual([]);
    branch.semantics = { mainPath: ["a", "c"] };
    expect(projectPlaybackSteps(branch).map(step => step.id)).toEqual(["a", "c"]);
    const cycle = flow(); cycle.relations = [...cycle.relations, { id: "ca", from: "c", to: "a", kind: "calls", evidence: [] }];
    expect(projectPlaybackSteps(cycle)).toEqual([]);
    const disconnected = flow(); disconnected.relations = disconnected.relations.slice(0, 1);
    expect(projectPlaybackSteps(disconnected)).toEqual([]);
  });
  it("uses recorded sequence message order and Archify for structural views too", () => {
    const sequence = { ...flow(), kind: "sequence" as const, semantics: { messages: [{ relationId: "bc", order: 2, kind: "call" as const, evidence: [] }, { relationId: "ab", order: 1, kind: "call" as const, evidence: [] }] } };
    expect(projectPlaybackSteps(sequence)).toEqual([{ id: "ab", kind: "relation" }, { id: "bc", kind: "relation" }]);
    expect(projectDiagramRenderer(sequence)).toBe("archify");
    expect(projectDiagramRenderer({ ...flow(), kind: "architecture" })).toBe("archify");
  });
});
