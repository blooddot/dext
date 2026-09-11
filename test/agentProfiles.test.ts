import type * as vscode from "vscode";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProfileStore, modelOptionsFromCodexCache } from "../src/agentProfiles.js";

describe("Agent profile defaults", () => {
  const temporaryDirectories: string[] = [];
  const restoreEnv: { configDir?: string | undefined; model?: string | undefined } = {};

  afterEach(async () => {
    if (restoreEnv.configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = restoreEnv.configDir;
    if (restoreEnv.model === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = restoreEnv.model;
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function claudeSettings(settings: unknown): Promise<void> {
    restoreEnv.configDir = process.env.CLAUDE_CONFIG_DIR;
    restoreEnv.model = process.env.ANTHROPIC_MODEL;
    const directory = await mkdtemp(join(tmpdir(), "dext-claude-settings-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "settings.json"), JSON.stringify(settings), "utf8");
    process.env.CLAUDE_CONFIG_DIR = directory;
    delete process.env.ANTHROPIC_MODEL;
  }

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

  it("shows the Claude default model configured through settings env", async () => {
    await claudeSettings({ env: { ANTHROPIC_MODEL: "claude-opus-5" }, effortLevel: "high" });

    expect(new AgentProfileStore().list().find((profile) => profile.id === "claude")?.defaults)
      .toEqual({ model: "opus", reasoningEffort: "high" });
  });

  it("keeps a configured Claude model that matches no composer alias", async () => {
    await claudeSettings({ model: "opusplan" });

    expect(new AgentProfileStore().list().find((profile) => profile.id === "claude")?.defaults?.model).toBe("opusplan");
  });

  it("exposes Harness as the third backend", () => {
    expect(new AgentProfileStore().list().map((profile) => profile.id)).toEqual(["codex", "claude", "deepseek-harness"]);
  });

  it("can expose only the profiles selected by the user", () => {
    const profiles = new AgentProfileStore().list(["codex", "claude"]);
    expect(profiles.map((profile) => profile.id)).toEqual(["codex", "claude"]);
  });

  it("ignores unsupported saved profiles and resets their model selection", () => {
    const state = { get: (key: string) => key === "dext.agentProfiles" ? [{ id: "obsolete", provider: "obsolete", models: [] }] : { profileId: "obsolete", model: "old-model" }, update: async () => undefined } as unknown as vscode.Memento;
    const store = new AgentProfileStore(state);
    expect(store.list().some((profile) => profile.id === "obsolete")).toBe(false);
    expect(store.currentSelection()).toMatchObject({ profileId: "codex", model: "" });
  });
});
