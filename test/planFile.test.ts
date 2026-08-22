import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN_DIRECTORY,
  planFileName,
  planPathSegments,
  planSlug,
  planTimestamp
} from "../src/core/planFile.js";

describe("plan documents", () => {
  it("reduces a goal to a portable file name", () => {
    expect(planSlug("Add a Redis cache")).toBe("add-a-redis-cache");
    expect(planSlug("  Fix: the /broken\\ path!!  ")).toBe("fix-the-broken-path");
    // A goal that is all punctuation still has to produce a usable name.
    expect(planSlug("??? !!!")).toBe("plan");
    expect(planSlug("重构历史面板")).toBe("plan");
  });

  it("keeps the slug short enough to stay under path limits", () => {
    const slug = planSlug("a".repeat(200));
    expect(slug).toHaveLength(48);
    // Truncation must not leave a trailing separator behind.
    expect(planSlug(`${"word ".repeat(20)}`).endsWith("-")).toBe(false);
  });

  it("names plans so a directory listing sorts chronologically", () => {
    const earlier = planTimestamp(new Date(2026, 7, 21, 9, 5, 3));
    const later = planTimestamp(new Date(2026, 7, 21, 22, 38, 9));
    expect(earlier).toBe("20260821-090503");
    expect(later < earlier).toBe(false);
    expect(planFileName("Add a cache", new Date(2026, 7, 21, 9, 5, 3)))
      .toBe("20260821-090503-add-a-cache.plan.md");
  });

  it("accepts workspace-relative plan paths and rejects escapes", () => {
    expect(planPathSegments(DEFAULT_PLAN_DIRECTORY)).toEqual([".dext", "plans"]);
    expect(planPathSegments(".\\.dext\\plans\\20260821-090503-x.plan.md"))
      .toEqual([".dext", "plans", "20260821-090503-x.plan.md"]);
    expect(() => planPathSegments("../outside/plan.md")).toThrow("inside the workspace");
    expect(() => planPathSegments(".dext/plans/../../etc/passwd")).toThrow("inside the workspace");
    expect(() => planPathSegments("/etc/passwd")).toThrow("relative to the workspace");
    expect(() => planPathSegments("C:/Windows/plan.md")).toThrow("relative to the workspace");
    expect(() => planPathSegments("   ")).toThrow("at least one segment");
  });
});
