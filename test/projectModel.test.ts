import { describe, expect, it } from "vitest";
import { projectModelNodeSchema, projectModelRelationSchema } from "../src/features/project/contracts/projectModel.js";
import { parseProjectModel } from "../src/features/project/knowledge/projectModel.js";
import { replaceKnowledgeBody } from "../src/features/project/knowledge/projectKnowledge.js";

export const node = (id: string) => projectModelNodeSchema.parse({ id, kind: "contract", title: id, canonicalName: id, body: { kind: "inline", text: "norm" } });
export const edge = (from: string, to: string, kind = "contains") => projectModelRelationSchema.parse({ id: `${from}:${to}`, from, to, kind });
describe("native Project model", () => {
  it("rejects duplicates, dangling edges and containment cycles but allows dependency cycles", () => {
    const model = { schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [node("a"), node("b")], relations: [] };
    expect(() => parseProjectModel({ ...model, nodes: [node("a"), node("a")] })).toThrow("Duplicate");
    expect(() => parseProjectModel({ ...model, relations: [edge("a", "missing")] })).toThrow("Dangling");
    expect(() => parseProjectModel({ ...model, relations: [edge("a", "b"), edge("b", "a")] })).toThrow("cycle");
    expect(() => parseProjectModel({ ...model, relations: [edge("a", "b", "depends_on"), edge("b", "a", "depends_on")] })).not.toThrow();
  });
  it("enforces one document owner and excludes plans and unsafe paths", () => {
    const body = { kind: "document", path: "docs/contract.md", contentHash: "h" };
    expect(() => parseProjectModel({ schemaVersion: 1, revision: 0, updatedAt: 0, relations: [], nodes: [{ ...node("a"), body }, { ...node("b"), body }] })).toThrow("multiple owners");
    for (const path of ["../escape.md", "a.plan.md", "C:/outside.md", "plans/work.md"]) expect(projectModelNodeSchema.safeParse({ ...node("a"), body: { ...body, path } }).success).toBe(false);
  });
  it("protects accepted bodies from generated replacements", () => {
    expect(() => replaceKnowledgeBody({ ...node("a"), review: "accepted" }, { kind: "inline", text: "new" }, "ai")).toThrow("proposal");
    expect(replaceKnowledgeBody(node("a"), { kind: "inline", text: "new" }, "user").review).toBe("edited");
  });
});
