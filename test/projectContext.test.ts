import { describe, expect, it } from "vitest";
import { buildProjectContext, captureTurnPreset, presetForRun, resolveReviewPreset, reviewPresetPresentation, searchProjectReferences } from "../src/core/projectContext.js";
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
  it("selects canonical names and aliases from Input within a character bound", () => {
    const snapshot = buildProjectContext({ input: "增加任务筛选", objects: [{ ...make("TaskFilter"), aliases: ["任务筛选"] }, make("TaskStats")], relatedObjectIds: [], maxCharacters: 100 });
    expect(snapshot.objectIds).toEqual(["TaskFilter"]);
    expect(snapshot.text.length).toBeLessThanOrEqual(100);
  });

  it("still builds a bounded context when no knowledge exists", () => {
    const snapshot = buildProjectContext({ input: "增加任务筛选", objects: [] });
    expect(snapshot.objectIds).toEqual([]);
    expect(snapshot.text).toBe("");
  });

  it("freezes the preset at send time with an override beating the project default", () => {
    const selection = resolveReviewPreset({ projectDefault: { preset: "engineering" }, override: "experience", mode: "agent", now: 5 });
    expect(selection).toEqual({ preset: "experience", origin: "override", readOnly: false, capturedAt: 5 });
    expect(resolveReviewPreset({ projectDefault: { preset: "experience" }, mode: "agent" }).preset).toBe("experience");
    expect(resolveReviewPreset({ mode: "agent" }).preset).toBe("engineering");
  });

  it("keeps Ask read-only no matter which preset is selected", () => {
    expect(resolveReviewPreset({ override: "experience", mode: "ask" }).readOnly).toBe(true);
    expect(resolveReviewPreset({ mode: "ask" }).readOnly).toBe(true);
    expect(resolveReviewPreset({ mode: "agent" }).readOnly).toBe(false);
  });

  it("presents engineering design emphasis and experience behavior emphasis", () => {
    expect(reviewPresetPresentation("engineering").emphasis).toBe("design");
    expect(reviewPresetPresentation("experience").emphasis).toBe("behavior");
  });

  it("binds the captured preset to one run and drops it for a retry's new identity", () => {
    const selection = resolveReviewPreset({ projectDefault: { preset: "experience" }, mode: "agent", now: 7 });
    const identity = { sessionId: "s", turnId: "t", runId: "run-1", attempt: 1 };
    const captured = captureTurnPreset(identity, selection, "agent");
    expect(captured).toMatchObject({ preset: "experience", origin: "project", runId: "run-1", attempt: 1, mode: "agent", capturedAt: 7 });
    expect(presetForRun(captured, identity)).toEqual(selection);
    // A retry is a new run identity, so the previous attempt's frozen preset does not apply.
    const retry = { sessionId: "s", turnId: "t", runId: "run-2", attempt: 2 };
    expect(presetForRun(captured, retry)).toBeUndefined();
    expect(presetForRun(undefined, identity)).toBeUndefined();
  });
});
