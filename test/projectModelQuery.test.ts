import { describe, expect, it } from "vitest";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";
import { queryProject } from "../src/features/project/knowledge/projectQuery.js";

const model = projectModelSchema.parse({ schemaVersion: 1, revision: 4, updatedAt: 0,
  nodes: ["a", "b", "c"].map(id => ({ id, title: id, canonicalName: id, kind: "module", body: { kind: "inline", text: "" } })),
  relations: [{ id: "ab", from: "a", to: "b", kind: "contains" }, { id: "bc", from: "b", to: "c", kind: "contains" }] });
describe("Project queries", () => {
  it("traverses persisted relationships in both directions and reports truncation", () => {
    expect(queryProject(model, { operation: "ancestors", id: "c", depth: 8 }).nodes.map(node => node.id)).toEqual(["a", "b", "c"]);
    expect(queryProject(model, { operation: "subtree", id: "a", depth: 8, limit: 2 }).truncated).toBe(true);
    expect(queryProject(model, { operation: "node", id: "b" }).nodes).toHaveLength(1);
    expect(() => queryProject(model, { operation: "neighbors", id: "missing" })).toThrow("not found");
    expect(() => queryProject(model, { operation: "summary", limit: 10000 })).toThrow();
  });
});
