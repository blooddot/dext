import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessPolicyPatch, harnessBinding, encodeHarnessSession, decodeHarnessSession, harnessLaunchSettingsFromYaml, harnessLaunchSettingsFromProfilePatch, readHarnessLaunchSettings } from "../src/features/agents/host/deepseekHarnessPolicy.js";
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
  it("reads the endpoint and models from the desktop profile patch", () => {
    expect(harnessLaunchSettingsFromYaml("llm-deepseek:\n  baseURL: https://settings.example/v1\n")).toEqual({
      deepseekProvider: { baseURL: "https://settings.example/v1" }
    });
    const settings = harnessLaunchSettingsFromProfilePatch(`- id: llm-deepseek
  config:
    baseURL: https://first.example/v1
- id: ui-chat
  config:
    transcriptView: standard
- id: llm-deepseek
  config:
    baseURL: https://second.example/v1
- id: agent-default-model
  config:
    provider: deepseek-official
`);
    // Only the mirrored ids survive, and the last row for an id is the one the loader keeps.
    expect(settings).toEqual({ deepseekProvider: { baseURL: "https://second.example/v1" } });
    expect(harnessLaunchSettingsFromProfilePatch("not: a list")).toBeUndefined();
    expect(harnessLaunchSettingsFromProfilePatch("- id: llm-deepseek\n  config: {}\n")).toEqual({});
  });
  it("prefers settings.yaml per field and falls back to the desktop profile", async () => {
    const home = await mkdtemp(join(tmpdir(), "dext-harness-launch-"));
    const settingsPath = join(home, "settings.yaml");
    const desktopPatchPath = join(home, "profiles", "desktop", "cordis.patch.yml");
    try {
      await mkdir(join(home, "profiles", "desktop"), { recursive: true });
      await writeFile(desktopPatchPath, `- id: llm-pi-ai
  config:
    providers:
      desktop: {}
- id: llm-deepseek
  config:
    baseURL: https://desktop.example/v1
    models:
      - id: deepseek-flash
        name: deepseek-flash
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: high
`, "utf8");
      await writeFile(settingsPath, "llm-pi-ai:\n  providers:\n    gateway:\n      apiKeyEnv: GATEWAY_KEY\n", "utf8");
      const merged = await readHarnessLaunchSettings(settingsPath, desktopPatchPath);
      expect(merged).toEqual({
        defaultModel: { provider: "deepseek-official", model: "deepseek-flash" },
        piAiProviders: { gateway: { apiKeyEnv: "GATEWAY_KEY" } },
        deepseekProvider: { baseURL: "https://desktop.example/v1", models: [{ id: "deepseek-flash", name: "deepseek-flash" }] }
      });
      const patch = JSON.parse(harnessPolicyPatch("read-only", process.cwd(), merged)) as { id: string; config: unknown }[];
      expect(patch.slice(0, 3)).toEqual([
        { id: "llm-pi-ai", config: { providers: { gateway: { apiKeyEnv: "GATEWAY_KEY" } } } },
        { id: "llm-deepseek", config: { baseURL: "https://desktop.example/v1", models: [{ id: "deepseek-flash", name: "deepseek-flash" }] } },
        { id: "acp", config: { provider: "deepseek-official", model: "deepseek-flash" } }
      ]);
      // Missing settings.yaml leaves the desktop values in place.
      await rm(settingsPath);
      await expect(readHarnessLaunchSettings(settingsPath, desktopPatchPath)).resolves.toMatchObject({
        defaultModel: { provider: "deepseek-official", model: "deepseek-flash" },
        deepseekProvider: { baseURL: "https://desktop.example/v1" }
      });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
