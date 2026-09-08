import { describe, expect, it } from "vitest";
import { codexConfiguredDefaults, type AgentProfile } from "../src/agentProfiles.js";
import { presentAgentSelection } from "../src/agentSelectionDefaults.js";

const profile: AgentProfile = {
  id: "codex", provider: "codex", command: "codex", label: "Codex CLI", models: ["first", "configured"],
  defaults: { model: "configured", reasoningEffort: "high", speed: "fast" },
  modelOptions: ["first", "configured"].map((id) => ({
    id, label: `Label ${id}`, defaultReasoningEffort: "medium", reasoningEfforts: ["medium", "high"], speedTiers: [], serviceTiers: []
  }))
};

describe("displaying inherited CLI settings", () => {
  it("resolves the reset values sent on CLI switch without choosing the first model or changing selection", () => {
    const selection = { profileId: "codex", model: "", reasoningEffort: "", speed: "", serviceTier: "" };
    const original = { ...selection };
    expect(presentAgentSelection(profile, selection)).toMatchObject({
      model: "configured", modelLabel: "Label configured", reasoningEffort: "high", speed: "fast"
    });
    expect(selection).toEqual(original);
  });

  it("uses explicit selections over inherited defaults", () => {
    expect(presentAgentSelection(profile, { model: "first", reasoningEffort: "medium", speed: "standard" }))
      .toMatchObject({ model: "first", reasoningEffort: "medium", speed: "standard" });
    expect(presentAgentSelection(profile, { serviceTier: "default" }).speed).toBe("standard");
  });

  it("shows custom configured models absent from the model cache with a matching menu option", () => {
    const view = presentAgentSelection({ ...profile, defaults: { model: "custom-model" } }, {});
    expect(view.modelLabel).toBe("custom-model");
    expect(view.options.find((item) => item.id === view.model)?.label).toBe("custom-model");
  });

  it("uses the model's advertised effort when no configured effort exists", () => {
    const view = presentAgentSelection({ ...profile, defaults: { model: "configured" } }, { reasoningEffort: "" });
    expect(view.reasoningEffort).toBe("medium");
  });

  it("does not claim the first available model is the native default when it is unknown", () => {
    const view = presentAgentSelection({ ...profile, defaults: {} }, {});
    expect(view.model).toBe("");
    expect(view.modelLabel).toBe("CLI setting");
  });

  it("uses the Harness model explicitly advertised as default", () => {
    const view = presentAgentSelection({ ...profile, provider: "deepseek-harness", defaults: {},
      modelOptions: profile.modelOptions!.map((item) => ({ ...item, isDefault: item.id === "configured" })) }, {});
    expect(view).toMatchObject({ model: "configured", reasoningEffort: "medium" });
  });

  it("reads Codex root defaults without accidentally using an inactive profile or provider", () => {
    expect(codexConfiguredDefaults([`model = "configured" # comment
model_reasoning_effort = 'high'
service_tier = "priority"
[profiles.unused]
model = "wrong-profile"
[model_providers.custom]
model = "wrong-provider"`])).toEqual({ model: "configured", reasoningEffort: "high", speed: "fast" });
  });

  it("layers workspace values and honors the selected Codex profile", () => {
    expect(codexConfiguredDefaults([
      `model = "global"\n[profiles.work]\nmodel = "profile-model"\nmodel_reasoning_effort = "high"`,
      `profile = "work"\nservice_tier = "default"`
    ])).toEqual({ model: "profile-model", reasoningEffort: "high", speed: "standard" });
  });
});
