import { describe, expect, it } from "vitest";
import { projectModelNodeSchema, projectModelRelationSchema } from "../src/features/project/contracts/projectModel.js";
import { parseProjectModel, projectModelIntent } from "../src/features/project/knowledge/projectModel.js";
import { buildProjectTopics } from "../src/features/project/knowledge/projectTopics.js";
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
  it("reads indexed modules as responsibility topics with their own dependency diagram", () => {
    const module = (id: string, title: string, text: string) => projectModelNodeSchema.parse({ id, kind: "module", title, canonicalName: title, body: { kind: "inline", text }, paths: [`src/${id}.ts`] });
    const model = parseProjectModel({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [
      projectModelNodeSchema.parse({ id: "project", kind: "project", title: "Demo", canonicalName: "Demo", body: { kind: "inline", text: "Goal" } }),
      module("core", "Core Unit", "## Responsibility\n\nOwns a."), module("ui", "UI Unit", "## Responsibility\n\nOwns b.")],
      relations: [projectModelRelationSchema.parse({ id: "core-ui", from: "core", to: "ui", kind: "depends_on" })] });
    const topics = buildProjectTopics(projectModelIntent(model));
    expect(topics.map(topic => [topic.kind, topic.title, topic.description])).toEqual([
      ["context", "Core Unit", "## Responsibility\n\nOwns a."],
      ["context", "UI Unit", "## Responsibility\n\nOwns b."]
    ]);
    // A module topic carries the dependency it has, so Knowledge shows a diagram instead of an empty page.
    expect(topics[0]?.diagram?.nodes.map(item => item.label)).toEqual(["Core Unit", "UI Unit"]);
    expect(topics[0]?.sourceFiles).toEqual(["src/core.ts"]);
  });
  it("turns an authored functional area into the reader's module group", () => {
    const module = (id: string) => projectModelNodeSchema.parse({ id, kind: "module", title: `${id} unit`, canonicalName: id, body: { kind: "inline", text: "Owns it." }, paths: [`src/${id}.ts`] });
    const model = parseProjectModel({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [
      module("core"), module("ui"),
      projectModelNodeSchema.parse({ id: "area:runtime", kind: "capability", title: "Core runtime", canonicalName: "Core runtime",
        body: { kind: "inline", text: "拥有核心运行时" }, properties: { moduleIds: ["core", "ui"] } })],
      relations: [projectModelRelationSchema.parse({ id: "a", from: "area:runtime", to: "core", kind: "maps_to" }),
        projectModelRelationSchema.parse({ id: "b", from: "area:runtime", to: "ui", kind: "maps_to" })] });
    const topics = buildProjectTopics(projectModelIntent(model));
    expect(topics.map(topic => [topic.title, topic.area?.title, topic.area?.description])).toEqual([
      ["core unit", "Core runtime", "拥有核心运行时"],
      ["ui unit", "Core runtime", "拥有核心运行时"]
    ]);
  });
});
