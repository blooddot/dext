import { describe, expect, it } from "vitest";
import { projectObjectSchema, type ProjectObject } from "../src/core/projectKnowledge.js";
import {
  affectedProjectObjectIds,
  validityAfterFactValidation,
  validateProjectObjectFacts,
  type FactSnapshot
} from "../src/core/projectKnowledgeValidation.js";

const object = (id: string, extra: Partial<ProjectObject> = {}): ProjectObject => projectObjectSchema.parse({
  id, canonicalName: id, kind: "module", source: "user", confirmation: "accepted", ...extra
});

const host = (snapshots: Record<string, FactSnapshot | undefined>) => ({
  snapshot: async (path: string) => snapshots[path]
});

describe("project knowledge validation", () => {
  it("reports deleted, changed and still-present evidence", async () => {
    const value = object("TaskQuery", {
      evidence: [
        { path: "src/a.ts", contentHash: "h1" },
        { path: "src/gone.ts", contentHash: "h2" },
        { path: "src/symbol.ts", symbol: "run" }
      ]
    });
    const facts = await validateProjectObjectFacts(value, host({
      "src/a.ts": { path: "src/a.ts", contentHash: "h1" },
      "src/symbol.ts": { path: "src/symbol.ts", contentHash: "h3", symbols: ["run"] }
    }));
    expect(facts.map((fact) => fact.kind)).toEqual(["present", "missing", "present"]);
  });

  it("keeps acceptance while moving validity to needs_verification or stale", async () => {
    const value = object("TaskQuery", { evidence: [{ path: "src/a.ts", contentHash: "h1" }] });
    const facts = await validateProjectObjectFacts(value, host({ "src/a.ts": { path: "src/a.ts", contentHash: "h2" } }));
    const updated = validityAfterFactValidation(value, facts);
    expect(updated).toMatchObject({ confirmation: "accepted", validity: "needs_verification", source: "user" });
    const stale = validityAfterFactValidation(value, [{ objectId: "TaskQuery", evidence: { path: "src/a.ts" }, kind: "missing" }]);
    expect(stale).toMatchObject({ confirmation: "accepted", validity: "stale" });
    const conflicted = validityAfterFactValidation(value, [
      { objectId: "TaskQuery", evidence: { path: "src/a.ts" }, kind: "missing" },
      { objectId: "TaskQuery", evidence: { path: "src/b.ts" }, kind: "changed" }
    ]);
    expect(conflicted.validity).toBe("conflicted");
  });

  it("expands affected objects through related ids", () => {
    const objects = [
      object("A", { paths: ["src/a.ts"] }),
      object("B", { relatedIds: ["A"] }),
      object("C", { relatedIds: ["B"] }),
      object("D")
    ];
    expect([...affectedProjectObjectIds(objects, ["src/a.ts"])].sort()).toEqual(["A", "B", "C"]);
  });
});
