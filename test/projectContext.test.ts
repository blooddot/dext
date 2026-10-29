import { describe, expect, it } from "vitest";
import { searchProjectReferences } from "../src/features/project/knowledge/projectContext.js";
import { projectIntentSchema } from "../src/features/project/contracts/projectIntent.js";
import { projectObjectSchema } from "../src/features/project/contracts/projectKnowledge.js";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";

const make = (canonicalName: string) => projectObjectSchema.parse({ id: canonicalName, canonicalName, kind: "feature", source: "ai", description: "feature" });

describe("project context", () => {
  it("offers native contracts and excludes legacy fallback once the model exists", () => {
    const model = projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [{ id: "contract", title: "API", canonicalName: "API", kind: "contract", body: { kind: "inline", text: "Contract" }, review: "accepted" }], relations: [] });
    const results = searchProjectReferences({ model, objects: [{ ...make("Legacy"), confirmation: "accepted" }], query: "" });
    expect(results.map(item => item.objectId)).toEqual(["contract"]);
  });
  it("offers only reviewed Project names including terms and bounded contexts", () => {
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example" },
      capabilities: [{ id: "cap", canonicalName: "TaskQuery", review: "accepted" }],
      contexts: [{ id: "ctx", canonicalName: "TaskDomain", displayName: "任务域", review: "edited" }],
      terms: [{ id: "term", canonicalName: "Task", aliases: ["工单"], review: "accepted" }, { id: "draft", canonicalName: "DraftTask" }] });
    const module = { ...make("TaskModule"), confirmation: "accepted" as const, validity: "needs_verification" as const };
    const options = { objects: [module, make("DraftModule")], intent, query: "" };
    expect(searchProjectReferences(options).map((item) => item.objectId).sort()).toEqual(["TaskModule", "cap", "ctx", "term"]);
    expect(searchProjectReferences({ ...options, query: "工单" })[0]?.token).toBe("#Task[term]");
    expect(searchProjectReferences({ ...options, query: "任务域" })[0]?.objectId).toBe("ctx");
    expect(searchProjectReferences({ ...options, limit: 1 })).toHaveLength(1);
    expect(module.validity).toBe("needs_verification");
  });
});
