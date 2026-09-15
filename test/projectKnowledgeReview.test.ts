import { describe, expect, it } from "vitest";
import { projectObjectSchema, type ProjectObject } from "../src/core/projectKnowledge.js";
import { applyKnowledgeSuggestion, isSuggestionSafeForAcceptedObject, type KnowledgeSuggestion } from "../src/core/projectKnowledgeReview.js";

const object = (id: string, extra: Partial<ProjectObject> = {}): ProjectObject => projectObjectSchema.parse({
  id, canonicalName: id, kind: "module", source: "user", confirmation: "accepted", version: 3, ...extra
});

const suggestion = (extra: Partial<KnowledgeSuggestion> = {}): KnowledgeSuggestion => ({
  id: "s1",
  objectId: "TaskQuery",
  kind: "update",
  proposed: { description: "Runs a bounded task query." },
  evidence: [{ path: "src/a.ts" }],
  reason: "Implementation changed.",
  source: "ai",
  baseVersion: 3,
  ...extra
});

describe("project knowledge review", () => {
  it("does not apply an AI suggestion to a newer accepted version", () => {
    const value = object("TaskQuery");
    expect(isSuggestionSafeForAcceptedObject(suggestion(), value)).toBe(true);
    expect(isSuggestionSafeForAcceptedObject(suggestion({ baseVersion: 2 }), value)).toBe(false);
    expect(isSuggestionSafeForAcceptedObject(suggestion({ objectId: "Other" }), value)).toBe(false);
  });

  it("keeps user decisions separate from the AI proposal", () => {
    const value = object("TaskQuery");
    const rejected = applyKnowledgeSuggestion(value, suggestion(), "rejected");
    expect(rejected).toEqual(value);
    const accepted = applyKnowledgeSuggestion(value, suggestion(), "accepted");
    expect(accepted).toMatchObject({
      description: "Runs a bounded task query.",
      source: "user",
      confirmation: "accepted",
      validity: "needs_verification",
      version: 4
    });
    // The accepted original is preserved when the user edits instead of accepting verbatim.
    const edited = applyKnowledgeSuggestion(value, suggestion(), "edited");
    expect(edited).toMatchObject({ source: "ai", validity: "needs_verification" });
    expect(edited?.confirmation).toBe("accepted");
  });

  it("creates a draft object from an AI proposal without confirming it", () => {
    const create: KnowledgeSuggestion = {
      id: "TaskSearch", kind: "create", proposed: { canonicalName: "TaskSearch" },
      evidence: [{ path: "src/search.ts" }], reason: "new module", source: "ai"
    };
    const created = applyKnowledgeSuggestion(undefined, create, "accepted", 0);
    expect(created).toMatchObject({ id: "TaskSearch", canonicalName: "TaskSearch", source: "ai", confirmation: "accepted", validity: "needs_verification", ownership: "candidate" });
  });

  it("removes an object only when the suggestion is not rejected", () => {
    const value = object("TaskQuery");
    expect(applyKnowledgeSuggestion(value, suggestion({ kind: "remove" }), "accepted")).toBeUndefined();
    expect(applyKnowledgeSuggestion(value, suggestion({ kind: "remove" }), "rejected")).toEqual(value);
  });
});
