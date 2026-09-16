import { describe, expect, it } from "vitest";
import { projectObjectSchema, type ProjectObject } from "../src/core/projectKnowledge.js";
import { KnowledgeDraftQueue, applyKnowledgeSuggestion, isSuggestionSafeForAcceptedObject, type KnowledgeSuggestion } from "../src/core/projectKnowledgeReview.js";

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

describe("knowledge draft queue", () => {
  it("keeps a rejected proposal suppressed for the same base version only", () => {
    const queue = new KnowledgeDraftQueue();
    expect(queue.enqueue(suggestion())).toBe(true);
    queue.decide("s1", "rejected", 10);
    expect(queue.list()).toEqual([]);
    // The decision outlives the draft, so the same proposal for the same version is not offered again.
    expect(queue.decisionFor("s1")).toMatchObject({ decision: "rejected", decidedAt: 10 });
    expect(queue.enqueue(suggestion())).toBe(false);
    // A newer object version is a genuinely new proposal.
    expect(queue.enqueue(suggestion({ baseVersion: 4 }))).toBe(true);
  });

  it("hands out copies so callers cannot mutate queued drafts", () => {
    const queue = new KnowledgeDraftQueue();
    queue.enqueue(suggestion());
    queue.list()[0]!.proposed.description = "tampered";
    expect(queue.list()[0]!.proposed.description).toBe("Runs a bounded task query.");
  });

  it("keeps an accepted draft and records an edit as the new proposal", () => {
    const queue = new KnowledgeDraftQueue();
    queue.enqueue(suggestion());
    expect(queue.decide("s1", "accepted", 20)).toMatchObject({ suggestionId: "s1", decision: "accepted", decidedAt: 20 });
    expect(queue.list()).toHaveLength(1);
    queue.decide("s1", "edited", 21, { description: "edited" });
    expect(queue.list()[0]!.proposed.description).toBe("edited");
    expect(queue.decisionFor("s1")).toMatchObject({ decision: "edited", edited: { description: "edited" } });
    expect(queue.decide("missing", "accepted")).toBeUndefined();
  });

  it("merges several drafts into one and drops the originals", () => {
    const queue = new KnowledgeDraftQueue();
    queue.enqueue(suggestion({ evidence: [{ path: "src/a.ts" }] }));
    queue.enqueue(suggestion({ id: "s2", evidence: [{ path: "src/b.ts" }] }));
    expect(queue.merge(["s1"], { id: "merged", proposed: {}, reason: "duplicates" })).toBeUndefined();

    const merged = queue.merge(["s1", "s2"], { id: "merged", proposed: { canonicalName: "Merged" }, reason: "duplicates" });
    expect(merged).toMatchObject({ id: "merged", kind: "merge", reason: "duplicates", baseVersion: 3 });
    expect(merged!.evidence.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(queue.list().map((item) => item.id)).toEqual(["merged"]);
  });

  it("splits one draft into independent drafts that inherit its evidence", () => {
    const queue = new KnowledgeDraftQueue();
    queue.enqueue(suggestion());
    expect(queue.split("s1", [{ id: "only", proposed: {}, reason: "one" }])).toEqual([]);
    expect(queue.split("missing", [{ id: "a", proposed: {}, reason: "a" }, { id: "b", proposed: {}, reason: "b" }])).toEqual([]);

    const parts = queue.split("s1", [
      { id: "part-a", proposed: { description: "a" }, reason: "first" },
      { id: "part-b", proposed: { description: "b" }, reason: "second" }
    ]);
    expect(parts.map((part) => part.id)).toEqual(["part-a", "part-b"]);
    expect(parts.every((part) => part.kind === "split" && part.baseVersion === 3)).toBe(true);
    expect(parts[0]!.evidence).toEqual([{ path: "src/a.ts" }]);
    expect(queue.list().map((item) => item.id)).toEqual(["part-a", "part-b"]);
  });
});
