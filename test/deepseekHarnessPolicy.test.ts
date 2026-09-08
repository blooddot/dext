import { describe, expect, it } from "vitest";
import { harnessPolicyPatch, harnessBinding, encodeHarnessSession, decodeHarnessSession, harnessLaunchSettingsFromYaml } from "../src/core/deepseekHarnessPolicy.js";
describe("Harness policy", () => {
  it.each(["read-only", "workspace-write", "full-access"] as const)("pins all user preset choices to %s", (permission) => {
    const patch = JSON.parse(harnessPolicyPatch(permission, process.cwd())) as { id: string; config: { presets?: Record<string, { sandbox: string; approval: string }> } }[];
    const presets = Object.values(patch.find((item) => item.id === "permission")!.config.presets!);
    expect(presets).toHaveLength(3);
    expect(presets.every((item) => item.sandbox === (permission === "full-access" ? "danger-full-access" : permission))).toBe(true);
    if (permission !== "full-access") expect(presets.every((item) => item.approval === "never")).toBe(true);
  });
  it("binds sessions to permission and launch configuration", async () => {
    const first = await harnessBinding(process.cwd(), "read-only", "dsh", []);
    expect(await harnessBinding(process.cwd(), "workspace-write", "dsh", [])).not.toBe(first);
    expect(await harnessBinding(process.cwd(), "read-only", "other-dsh", [])).not.toBe(first);
    expect(decodeHarnessSession(encodeHarnessSession("native-id", first))).toEqual({ id: "native-id", binding: first });
    expect(() => decodeHarnessSession("native-id")).toThrow("Invalid");
  });
  it("mirrors the settings-defined provider and default route only into the disposable ACP overlay", async () => {
    const settings = harnessLaunchSettingsFromYaml(`llm-pi-ai:\n  providers:\n    openai:\n      apiKeyEnv: OPENAI_API_KEY\n      baseURL: https://gateway.example/v1\n      models:\n        - id: deepseek-v4-flash\nagent-default-model:\n  provider: openai\n  model: deepseek-v4-flash\n`);
    expect(settings).toMatchObject({ defaultModel: { provider: "openai", model: "deepseek-v4-flash" }, piAiProviders: { openai: { apiKeyEnv: "OPENAI_API_KEY" } } });
    expect(harnessLaunchSettingsFromYaml("agent-default-model:\n  provider: openai\n")).toEqual({});
    const patch = JSON.parse(harnessPolicyPatch("read-only", process.cwd(), settings)) as { id: string; config: unknown }[];
    expect(patch.slice(0, 2)).toEqual([
      { id: "llm-pi-ai", config: { providers: settings?.piAiProviders } },
      { id: "acp", config: settings?.defaultModel }
    ]);
    const baseline = await harnessBinding(process.cwd(), "read-only", "dsh", []);
    expect(await harnessBinding(process.cwd(), "read-only", "dsh", [], settings)).not.toBe(baseline);
  });
});
