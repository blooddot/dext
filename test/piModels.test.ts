import { describe, expect, it } from "vitest";
import { decodePiSession, encodePiSession, parsePiModelId, piModelId, piModelOptions, piModels, piThinkingLevels } from "../src/features/agents/domain/piModels.js";

describe("Pi model and session contracts", () => {
  it("keeps provider identity and slash-containing model ids", () => {
    expect(parsePiModelId("gateway/org/flash")).toEqual({ provider: "gateway", id: "org/flash" });
    expect(piModelId({ provider: "gateway", id: "org/flash" })).toBe("gateway/org/flash");
    for (const id of ["flash", "/flash", "gateway/", " gateway/flash"]) expect(() => parsePiModelId(id)).toThrow();
  });
  it("uses advertised capabilities without inventing tiers", () => {
    const models = piModels([{ provider: "a", id: "flash", name: "Flash", reasoning: true }, { provider: "b", id: "flash", reasoning: false }]);
    const options = piModelOptions(models, { model: models[0]!, thinkingLevel: "high" }, new Map([["a/flash", ["off", "high"]]]));
    expect(options[0]).toMatchObject({ id: "a/flash", group: "a", isDefault: true, reasoningEfforts: ["off", "high"], defaultReasoningEffort: "high", speedTiers: [], serviceTiers: [] });
    expect(options[1]).toMatchObject({ id: "b/flash", reasoningEfforts: ["off"], isDefault: false });
    expect(piModelOptions(models, {})[0]?.reasoningEfforts).toEqual([]);
  });
  it("rejects malformed advertised models and thinking levels", () => {
    expect(() => piModels([{ id: "flash" }])).toThrow();
    expect(() => piModels(null)).toThrow();
    expect(piThinkingLevels(["off", "high", "high"])).toEqual(["off", "high"]);
    expect(() => piThinkingLevels([])).toThrow();
  });
  it("round-trips versioned unicode Windows paths and rejects corrupt bindings", () => {
    const session = { path: "C:\\会话\\a.jsonl", binding: "scope-fingerprint" };
    expect(decodePiSession(encodePiSession(session))).toEqual(session);
    for (const value of ["raw-session", "pi1:%", "pi1:%7B%7D"]) expect(() => decodePiSession(value)).toThrow("binding is invalid");
  });
});
