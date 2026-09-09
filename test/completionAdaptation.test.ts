import { describe, expect, it } from "vitest";
import { adaptationKey, adaptationPolicy } from "../src/core/completionAdaptation.js";
describe("bounded adaptation", () => {
  it("requires twenty effective samples and limits every adjustment", () => {
    expect(adaptationPolicy({ retained: 19, undone: 0, modified: 0, updated: 0 }).output).toBe(1);
    expect(adaptationPolicy({ retained: 20, undone: 0, modified: 0, updated: 0 }).output).toBeGreaterThan(1);
    expect(adaptationPolicy({ retained: 100000, undone: 0, modified: 0, updated: 0 }).output).toBeLessThanOrEqual(1.2);
    expect(adaptationPolicy({ retained: 0, undone: 100000, modified: 0, updated: 0 }).output).toBe(0.8);
  });
  it("isolates backend-account-model identities, languages and completion scenes", () => {
    const keys = [adaptationKey("http/account-a/m1", "ts", true), adaptationKey("http/account-b/m1", "ts", true), adaptationKey("http/account-a/m2", "ts", true), adaptationKey("codex/account-a/m1", "ts", true), adaptationKey("http/account-a/m1", "py", true), adaptationKey("http/account-a/m1", "ts", false)];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
