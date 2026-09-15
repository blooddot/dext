import { describe, expect, it } from "vitest";
import { normalizeProjectObject, projectObjectSchema, validateProjectObjects } from "../src/core/projectKnowledge.js";

const object = (id: string, canonicalName: string) => projectObjectSchema.parse({
  id, canonicalName, kind: "module", source: "user", confirmation: "accepted"
});

describe("project knowledge", () => {
  it("requires an English canonical name and detects aliases shared by objects", () => {
    expect(() => projectObjectSchema.parse({ id: "one", canonicalName: "任务", kind: "module", source: "user", confirmation: "accepted" })).toThrow();
    const first = { ...object("one", "TaskQuery"), aliases: ["查询"] };
    const second = { ...object("two", "TaskStats"), aliases: ["查询"] };
    expect(validateProjectObjects([first, second]).some((error) => error.includes("used by"))).toBe(true);
  });

  it("keeps source, confirmation and validity as independent dimensions", () => {
    const value = object("one", "TaskQuery");
    // An accepted object can simultaneously need verification; acceptance is not lost.
    const needsReview = { ...value, validity: "needs_verification" as const };
    expect(needsReview).toMatchObject({ confirmation: "accepted", validity: "needs_verification", source: "user" });
    expect(() => projectObjectSchema.parse({ id: "x", canonicalName: "Task", kind: "module", source: "detected", confirmation: "bogus" })).toThrow();
  });

  it("migrates the legacy single-axis status without dropping acceptance", () => {
    const migrated = normalizeProjectObject({ id: "one", canonicalName: "TaskQuery", kind: "module", source: "user", status: "accepted" });
    expect(migrated).toMatchObject({ confirmation: "accepted", validity: "current", source: "user" });
    const stale = normalizeProjectObject({ id: "two", canonicalName: "TaskStats", kind: "module", source: "user", status: "stale" });
    expect(stale).toMatchObject({ confirmation: "accepted", validity: "stale" });
    // Explicit new-dimensional values win over the legacy status.
    const explicit = normalizeProjectObject({ id: "three", canonicalName: "TaskLog", kind: "module", source: "ai", status: "accepted", confirmation: "draft" });
    expect(explicit.confirmation).toBe("draft");
  });
});
