import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentProfile } from "../src/agentProfiles.js";
import { copyHarnessPreset, harnessInstallation, harnessPresetFile, harnessPresetPatch, listHarnessPresets } from "../src/core/harnessPresets.js";
import { createHarnessPolicy } from "../src/core/deepseekHarnessPolicy.js";
import { DeepSeekHarnessTransport } from "../src/core/deepseekHarnessTransport.js";

// Opt-in native integration: no model prompts or API charges. All generated
// profiles, sessions and custom presets belong to this temporary Harness home.
describe.skipIf(!process.env.DEXT_TEST_DSH)("installed Harness presets", { timeout: 45_000 }, () => {
  let directory: string;
  const originalHome = process.env.DSH_HOME;
  const profile: AgentProfile = { id: "deepseek-harness", provider: "deepseek-harness", label: "Harness", command: process.env.DEXT_TEST_DSH ?? "dsh", models: [] };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "dext-preset-integration-"));
    process.env.DSH_HOME = directory;
  });
  afterAll(async () => {
    if (originalHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = originalHome;
    await rm(directory, { recursive: true, force: true });
  });

  it("discovers real presets, copies their files and reports broken edits", async () => {
    const presets = await listHarnessPresets(profile);
    expect(presets.map((preset) => preset.id)).toEqual(["standard", "ptc", "minimal", "cordis"]);
    expect(presets.every((preset) => !preset.error)).toBe(true);
    const file = await copyHarnessPreset(profile, "standard", "review-copy");
    expect(await readFile(file, "utf8")).toContain("@deepseek-ai/dsh-persona");
    expect(await harnessPresetFile(profile, "review-copy")).toBe(file);
    await expect(copyHarnessPreset(profile, "standard", "review-copy")).rejects.toThrow("already exists");
    await expect(copyHarnessPreset(profile, "standard", "../escape")).rejects.toThrow();
    await writeFile(file, "invalid: [", "utf8");
    const broken = (await listHarnessPresets(profile)).find((preset) => preset.id === "review-copy");
    expect(broken?.error).toBeTruthy();
    await expect(harnessPresetPatch(profile, "review-copy", "full-access")).rejects.toThrow("review-copy");
    await copyHarnessPreset(profile, "minimal", "custom-minimal");
  });

  it("refuses unconfined presets in restricted modes", async () => {
    await expect(harnessPresetPatch(profile, "minimal", "read-only")).rejects.toThrow("Full access");
    await expect(harnessPresetPatch(profile, "cordis", "workspace-write")).rejects.toThrow("Full access");
    await expect(harnessPresetPatch(profile, "custom-minimal", "workspace-write")).rejects.toThrow("Full access");
  });

  it.each(["standard", "ptc", "minimal", "cordis", "custom-minimal"])("mounts and resumes %s with its own tools", async (preset) => {
    const install = harnessInstallation(profile.command);
    const output = join(directory, `${preset}.jsonl`);
    const patch = await harnessPresetPatch(profile, preset, "full-access");
    patch.push({ insert: [{ id: "dext-preset-probe", name: pathToFileURL(resolve("test/fixtures/harnessPresetProbe.mjs")).href, config: {
      output, scopeModule: createRequire(install.entry).resolve("@deepseek-ai/dsh-scope")
    } }] });
    patch.push({ id: "dext-acp-presets", inject: ["acpAppStartup", "dextPresetProbeReady"] });
    const policy = await createHarnessPolicy("full-access", process.cwd(), undefined, patch);
    const launch = (): DeepSeekHarnessTransport => new DeepSeekHarnessTransport(profile.command,
      ["--profile", "acp", "--patch", policy.path], process.cwd(), {
        sessionUpdate: async () => undefined,
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } })
      });
    let transport = launch();
    try {
      await transport.initialize();
      const session = await transport.wait(transport.connection.newSession({ cwd: process.cwd(), mcpServers: [] }));
      await transport.wait(transport.connection.closeSession({ sessionId: session.sessionId }));
      await transport.close();
      transport = launch();
      await transport.initialize();
      await transport.wait(transport.connection.resumeSession({ sessionId: session.sessionId, cwd: process.cwd(), mcpServers: [] }));
      await transport.wait(transport.connection.closeSession({ sessionId: session.sessionId }));
      const observations = (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { preset: string; tools: string[]; mode: string });
      expect(observations).toHaveLength(2);
      for (const observation of observations) {
        expect(observation.preset).toBe(preset);
        expect(observation.tools.length).toBeGreaterThan(0);
        expect(observation.mode).toBe(preset === "ptc" ? "ptc" : "native");
        if (preset.endsWith("minimal")) expect(observation.tools).toHaveLength(2);
        if (preset === "ptc") expect(observation.tools).toContain("run_code");
        if (preset === "cordis") expect(observation.tools.some((tool) => tool.includes("cordis"))).toBe(true);
      }
    } finally { await transport.close(); await policy.dispose(); }
  });
});
