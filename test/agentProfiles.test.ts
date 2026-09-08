import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { AgentProfileStore, modelOptionsFromCodexCache } from "../src/agentProfiles.js";

describe("Agent profile defaults", () => {
  it("does not expose Codex models marked hidden in the local cache", () => {
    const options = modelOptionsFromCodexCache([
      { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide" },
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "show" }
    ]);

    expect(options.map((option) => option.id)).toEqual(["gpt-5.6-sol"]);
  });

  it("exposes Claude Code models and supported effort levels", () => {
    const claude = new AgentProfileStore().list().find((profile) => profile.id === "claude");
    expect(claude).toMatchObject({ label: "Claude CLI", provider: "claude", command: "claude" });
    expect(claude?.modelOptions?.map((model) => model.id)).toEqual(["opus", "sonnet"]);
    expect(claude?.modelOptions?.[0]?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("launches AIOA by default while retaining Attach as an explicit option", () => {
    const aioa = new AgentProfileStore().list().find((profile) => profile.id === "aioa");
    expect(aioa).toMatchObject({ provider: "aioa", connectionMode: "launch" });
  });

  it("can expose only the profiles selected by the user", () => {
    const profiles = new AgentProfileStore().list(["codex", "claude"]);
    expect(profiles.map((profile) => profile.id)).toEqual(["codex", "claude"]);
  });

  it("migrates the legacy Qunshu profile and selection to AIOA", () => {
    const state = {
      get<T>(key: string): T | undefined {
        if (key === "dext.agentProfiles") return [{ id: "qunshu", label: "群枢", provider: "qunshu", command: "", models: [] }] as T;
        if (key === "dext.agentSelection") return { profileId: "qunshu" } as T;
        return undefined;
      },
      update: async () => undefined
    } as unknown as vscode.Memento;
    const store = new AgentProfileStore(state);
    expect(store.list().find((profile) => profile.id === "aioa")).toMatchObject({ label: "AIOA", provider: "aioa" });
    expect(store.currentSelection()).toEqual({ profileId: "aioa" });
  });
});
