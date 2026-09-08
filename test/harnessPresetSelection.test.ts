import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { AgentProfileStore } from "../src/agentProfiles.js";
import { DextConversationPreferences } from "../src/conversationPreferences.js";
import { createHarnessPolicy, harnessBinding } from "../src/core/deepseekHarnessPolicy.js";
import { webviewRequestSchema } from "../src/webviewProtocol.js";

describe("Harness preset selection", () => {
  it("preserves each conversation's preset and explicit ACP default", async () => {
    const values = new Map<string, unknown>();
    const state = { get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
      update: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); } };
    const profiles = new AgentProfileStore(state as never);
    profiles.setSelection({ profileId: "deepseek-harness", agentPreset: "ptc" });
    expect(new AgentProfileStore(state as never).currentSelection().agentPreset).toBe("ptc");
    const preferences = new DextConversationPreferences(state as never);
    await preferences.setConversationSelection("one", { profileId: "deepseek-harness", agentPreset: "ptc" });
    await preferences.setConversationSelection("two", { profileId: "deepseek-harness", agentPreset: "" });
    const restored = new DextConversationPreferences(state as never);
    expect(restored.conversationSelection("one")?.agentPreset).toBe("ptc");
    expect(restored.conversationSelection("two")?.agentPreset).toBe("");
  });

  it("accepts bounded preset selections and only supported management actions", () => {
    const selection = { mode: "agent", permission: "workspace-write", profileId: "deepseek-harness", model: "", reasoningEffort: "", speed: "", serviceTier: "", agentPreset: "ptc" };
    expect(webviewRequestSchema.parse({ type: "agentSelection", selection })).toMatchObject({ selection: { agentPreset: "ptc" } });
    expect(webviewRequestSchema.safeParse({ type: "agentSelection", selection: { ...selection, agentPreset: "x".repeat(129) } }).success).toBe(false);
    expect(webviewRequestSchema.safeParse({ type: "harnessPresetAction", action: "copy" }).success).toBe(true);
    expect(webviewRequestSchema.safeParse({ type: "harnessPresetAction", action: "delete-all" }).success).toBe(false);
  });

  it("binds native sessions to their preset without changing legacy bindings", async () => {
    const cwd = process.cwd();
    const baseline = await harnessBinding(cwd, "read-only", "dsh", []);
    expect(await harnessBinding(cwd, "read-only", "dsh", [], undefined, "")).toBe(baseline);
    const standard = await harnessBinding(cwd, "read-only", "dsh", [], undefined, "standard");
    expect(standard).not.toBe(baseline);
    expect(await harnessBinding(cwd, "read-only", "dsh", [], undefined, "ptc")).not.toBe(standard);
  });

  it("keeps final permission policy after preset composition and keeps the ACP adapter", async () => {
    const adapter = { insert: [{ id: "dext-acp-presets", name: "file:///adapter.mjs", config: { preset: "standard" } }] };
    const policy = await createHarnessPolicy("read-only", process.cwd(), { defaultModel: { provider: "test", model: "test-model" } }, [{ id: "acp", disabled: true }, adapter]);
    try {
      const rows = JSON.parse(await readFile(policy.path, "utf8")) as { id: string; config: unknown }[];
      expect(rows[0]).toEqual({ id: "acp", disabled: true });
      expect(rows[1]).toEqual(adapter);
      expect(rows.filter((row) => row.id === "acp").at(-1)).toMatchObject({ config: { provider: "test", model: "test-model" } });
      expect(rows.at(-1)).toMatchObject({ id: "permission", config: { defaultPreset: "read-only" } });
      expect(rows.find((row) => row.id === "sandbox-policy")).toMatchObject({ config: { mode: "read-only" } });
    } finally { await policy.dispose(); }
  });
});
