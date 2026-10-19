import { describe, expect, it } from "vitest";
import { searchProjectReferences } from "../src/core/projectContext.js";
import { projectIntentSchema } from "../src/core/projectIntent.js";
import { projectObjectSchema } from "../src/core/projectKnowledge.js";

const make = (canonicalName: string) => projectObjectSchema.parse({ id: canonicalName, canonicalName, kind: "feature", source: "ai", description: "feature" });

describe("project context", () => {
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
