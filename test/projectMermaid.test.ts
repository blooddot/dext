import { describe, expect, it } from "vitest";
import { projectDiagramToMermaid } from "../src/features/project/presentation/projectMermaid.js";
import type { ProjectDiagram } from "../src/features/project/contracts/projectDiagram.js";

const diagram: ProjectDiagram = {
  schemaVersion: 1, id: "example", title: "Example", kind: "workflow", version: 1, updatedAt: 1,
  nodes: ["a", "b"].map((id) => ({ id, label: id, role: "step", semanticIds: [id], evidence: [] })),
  relations: [{ id: "forward", from: "a", to: "b", kind: "calls", label: "request", evidence: [] }, { id: "back", from: "b", to: "a", kind: "returns", label: "result", evidence: [] }]
};

describe("Project Mermaid conversion", () => {
  it("preserves stable IDs outside safe Mermaid tokens and encodes model text", () => {
    const view = projectDiagramToMermaid({ ...diagram, nodes: [{ ...diagram.nodes[0]!, label: 'end\n"] --> hacked %%{init:{}}%% <script>' }, diagram.nodes[1]!] });
    expect(view.source).toContain("N0 E0@-->");
    expect(view.source).not.toContain("<script>");
    expect(view.source).not.toContain("%%");
    expect(view.nodes).toEqual([{ key: "N0", id: "a" }, { key: "N1", id: "b" }]);
    expect(view.relations.map((relation) => relation.id)).toEqual(["forward", "back"]);
  });
  it("orders sequence messages by recorded order, including return arrows and guards", () => {
    const view = projectDiagramToMermaid({ ...diagram, kind: "sequence", semantics: { messages: [
      { relationId: "back", order: 2, kind: "return", evidence: [] },
      { relationId: "forward", order: 1, kind: "call", condition: "ready", evidence: [] }
    ] } });
    expect(view.relations.map((relation) => relation.id)).toEqual(["forward", "back"]);
    expect(view.source).toContain("N1-->>N0: result");
    expect(view.source).toContain("ready");
    expect(projectDiagramToMermaid({ ...diagram, kind: "sequence" })).toMatchObject({ kind: "flowchart", note: expect.stringContaining("not recorded") });
  });
  it("preserves lifecycle initial/terminal states, events and conditions", () => {
    const view = projectDiagramToMermaid({ ...diagram, kind: "lifecycle", semantics: {
      states: [{ nodeId: "a", kind: "initial", evidence: [] }, { nodeId: "b", kind: "terminal", evidence: [] }],
      transitions: [{ relationId: "forward", event: "Complete", condition: "success", evidence: [] }]
    } });
    expect(view.source).toContain("[*] --> N0");
    expect(view.source).toContain("N1 --> [*]");
    expect(view.source).toContain("Complete #183; success");
  });
});
