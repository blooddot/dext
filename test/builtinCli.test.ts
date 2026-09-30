import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/agentProfiles.js";
import { builtinCliFields, CLI_BUILTIN_IDS, specializeBuiltinCli } from "../src/core/builtinCli.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver } from "../src/core/contextResolver.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import type { AgentExecutionRequest } from "../src/core/agentRunner.js";
import type { ExecutionMetadata, InvocationValue } from "../src/core/types.js";

const profiles: AgentProfile[] = [
  { id: "codex", provider: "codex", command: "codex", label: "Codex", models: ["gpt-test", "gpt-other"] },
  { id: "claude", provider: "claude", command: "claude", label: "Claude", models: ["sonnet", "opus"] },
  { id: "deepseek-harness", provider: "deepseek-harness", command: "dsh", label: "Harness", models: [] }
];

function setup() {
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const runtime = new DextRuntime(registry, new ContextResolver({
    selection: async () => undefined, activeFile: async () => undefined,
    file: async () => undefined, symbol: async () => undefined, dir: async () => undefined
  }));
  runtime.setAgentProfiles(profiles);
  runtime.setAgentSelection({ profileId: "codex", model: "gpt-test", reasoningEffort: "high", speed: "fast", serviceTier: "priority" });
  runtime.setSkillLoader(async () => ({ instructions: "Follow the skill", sourcePath: "/skill/SKILL.md" }));
  const requests: AgentExecutionRequest[] = [];
  runtime.setAgentRunner({ run: async (request) => {
    requests.push(request);
    return { kind: request.method.output.kind, text: "done" };
  } });
  const execute = (args: Record<string, InvocationValue>, method = "ask", metadata: ExecutionMetadata = {}) => runtime.execute({
    kind: "invocation", source: "code", method,
    arguments: Object.entries({ input: "test", ...args }).map(([name, value]) => ({ name, value }))
  }, [], metadata);
  return { registry, runtime, requests, execute };
}

describe("per-call built-in CLI options", () => {
  it("routes Harness object options without inherited Codex tiers", async () => {
    const { execute, requests } = setup();
    await execute({ cli: "deepseek-harness", model: { model: "opaque-id", reasoning: "off" } });
    expect(requests[0]).toMatchObject({ profile: { provider: "deepseek-harness" }, model: "opaque-id", reasoningEffort: "off" });
    expect(requests[0]?.speed).toBeUndefined();
    expect(requests[0]?.serviceTier).toBeUndefined();
    await expect(execute({ cli: "deepseek-harness", model: { model: "opaque-id", speed: "fast" } })).rejects.toThrow();
  });
  it.each(["ask", "plan", "agent", "skill"])("routes %s to Claude without inherited Codex settings", async (method) => {
    const { execute, requests } = setup();
    await execute({ cli: "claude", model: "sonnet", ...(method === "agent" ? { apply: false } : {}), ...(method === "skill" ? { skill: "test" } : {}) }, method);
    expect(requests[0]).toMatchObject({ profile: { id: "claude" }, model: "sonnet" });
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[0]?.speed).toBeUndefined();
    expect(requests[0]?.serviceTier).toBeUndefined();
  });

  it("overrides model, reasoning, and speed while preserving unrelated metadata", async () => {
    const { execute, requests } = setup();
    await execute({ cli: "codex", model: { model: "gpt-other", reasoning: "ultra", speed: "standard" } }, "ask", { instruction: "test instruction", model: "decorator-model" });
    expect(requests[0]).toMatchObject({ profile: { id: "codex" }, model: "gpt-other", reasoningEffort: "ultra", speed: "standard", metadata: { instruction: "test instruction" } });
    expect(requests[0]?.serviceTier).toBeUndefined();
  });

  it("keeps calls isolated and preserves the existing selection when omitted", async () => {
    const { execute, requests } = setup();
    await execute({ cli: "claude", model: "opus" });
    await execute({});
    expect(requests[1]).toMatchObject({ profile: { id: "codex" }, model: "gpt-test", reasoningEffort: "high", speed: "fast" });
  });

  it("uses the current CLI to validate a model-only override", async () => {
    const { execute, runtime, requests } = setup();
    await execute({ model: { model: "gpt-test", reasoning: "low" } });
    expect(requests[0]).toMatchObject({ model: "gpt-test", reasoningEffort: "low" });
    runtime.setAgentSelection({ profileId: "claude", model: "opus" });
    await execute({ model: "sonnet" });
    expect(requests[1]).toMatchObject({ profile: { id: "claude" }, model: "sonnet" });
  });

  it.each([
    { cli: "unsupported" },
    { cli: "claude", model: "gpt-test" },
    { cli: "claude", model: { model: "gpt-test" } },
    { cli: "codex", model: "sonnet" },
    { cli: "codex", model: { model: "missing-model" } },
    { cli: "codex", model: { model: "gpt-test", reasoning: "turbo" } },
    { cli: "codex", model: { model: "gpt-test", speed: "priority" } },
    { cli: "codex", model: { model: "gpt-test", advanced: "priority" } },
    { cli: "codex", model: { reasoning: "high" } }
  ])("rejects unsupported options before invoking a CLI: %j", async (args) => {
    const { execute, requests } = setup();
    await expect(execute(args)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("does not fall back to an echo handler for an explicitly unconfigured CLI", async () => {
    const { runtime, execute, requests } = setup();
    runtime.setAgentProfiles(profiles.slice(0, 1));
    await expect(execute({ cli: "claude" })).rejects.toThrow("not configured");
    expect(requests).toHaveLength(0);
  });

  it("does not borrow composer settings from a different decorator-selected CLI", async () => {
    const { execute, requests } = setup();
    await execute({ cli: "claude", model: "opus" }, "ask", { agent: "claude" });
    expect(requests[0]?.model).toBe("opus");
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[0]?.speed).toBeUndefined();
  });

  it.each(["ask", "plan", "agent", "skill"])("uses CLI defaults when only cli is provided to %s", async (method) => {
    const { execute, requests } = setup();
    for (const cli of ["codex", "claude"]) {
      await execute({ cli, ...(method === "agent" ? { apply: false } : {}), ...(method === "skill" ? { skill: "test" } : {}) }, method,
        { agent: "codex", model: "decorator-model", reasoningEffort: "ultra", speed: "fast", serviceTier: "priority" });
      const request = requests.at(-1);
      expect(request?.profile.id).toBe(cli);
      expect(request?.model || undefined).toBeUndefined();
      expect(request?.reasoningEffort).toBeUndefined();
      expect(request?.speed).toBeUndefined();
      expect(request?.serviceTier).toBeUndefined();
    }
  });

  it("uses CLI defaults for omitted options even when the explicit CLI and model match Input", async () => {
    const { execute, requests, runtime } = setup();
    await execute({ cli: "codex", model: { model: "gpt-test" } });
    await execute({ cli: "codex", model: { model: "gpt-test", reasoning: "low" } });
    await execute({ cli: "codex", model: { model: "gpt-test", speed: "standard" } });
    runtime.setAgentSelection({ profileId: "claude", model: "opus", reasoningEffort: "high" });
    await execute({ cli: "claude", model: "opus" });
    expect(requests.map((request) => request.model)).toEqual(["gpt-test", "gpt-test", "gpt-test", "opus"]);
    expect(requests.map((request) => request.reasoningEffort)).toEqual([undefined, "low", undefined, undefined]);
    expect(requests.map((request) => request.speed)).toEqual([undefined, undefined, "standard", undefined]);
    expect(requests.every((request) => request.serviceTier === undefined)).toBe(true);
  });

  it("uses Input's CLI for a model-only override, including when a decorator selects another CLI", async () => {
    const { execute, requests } = setup();
    await execute({ model: { model: "gpt-test", reasoning: "low" } }, "ask", { agent: "claude", model: "opus" });
    expect(requests[0]).toMatchObject({ profile: { id: "codex" }, model: "gpt-test", reasoningEffort: "low", speed: "fast" });
  });
});

describe("built-in CLI contract", () => {
  const modelField = (source: readonly AgentProfile[]) => builtinCliFields(source).find((field) => field.name === "model")!;

  it("lists exactly the built-in ids that accept CLI overrides", () => {
    expect([...CLI_BUILTIN_IDS].sort()).toEqual(["agent", "ask", "create", "plan", "skill", "template"]);
    for (const id of ["ask", "plan", "agent", "template", "skill"]) expect(CLI_BUILTIN_IDS.has(id)).toBe(true);
    expect(CLI_BUILTIN_IDS.has("terminal")).toBe(false);
    expect(CLI_BUILTIN_IDS.has("ui.select")).toBe(false);
  });

  it("declares the cli enum and the Codex model dictionary", () => {
    const fields = builtinCliFields(profiles);
    expect(fields.map((field) => field.name)).toEqual(["cli", "model"]);
    expect(fields[0]).toMatchObject({ type: "enum", values: ["codex", "claude", "deepseek-harness"] });
    expect(modelField(profiles)).toMatchObject({
      type: "enum",
      accepts: ["object"],
      values: ["sonnet", "opus"],
      shapeType: "agent.ModelOptions"
    });
    expect(modelField(profiles).properties?.find((field) => field.name === "model"))
      .toMatchObject({ type: "enum", values: ["gpt-test", "gpt-other"], required: true });
    expect(modelField(profiles).properties?.map((field) => field.name)).toEqual(["model", "reasoning", "speed"]);
    // Without a configured Codex profile the model id stays a free string.
    expect(modelField(profiles.slice(1)).properties?.find((field) => field.name === "model")?.type).toBe("string");
  });

  it("specializes the model contract to the selected CLI", () => {
    const ask = BUILTIN_METHODS.find((method) => method.id === "ask")!;
    const model = (method: typeof ask) => method.input.find((field) => field.name === "model")!;

    expect(model(specializeBuiltinCli(ask, "deepseek-harness"))).toMatchObject({
      type: "object",
      accepts: [],
      properties: [
        expect.objectContaining({ name: "model", type: "string", required: true }),
        expect.objectContaining({ name: "reasoning", type: "string" })
      ]
    });
    expect(model(specializeBuiltinCli(ask, "codex"))).toMatchObject({ type: "object", accepts: [] });
    expect(model(specializeBuiltinCli(ask, "claude"))).toMatchObject({ type: "enum", accepts: [] });
    expect(model(specializeBuiltinCli(ask, "claude")).properties).toBeUndefined();

    // An unknown or absent CLI keeps the shared union until runtime.
    expect(specializeBuiltinCli(ask, undefined)).toBe(ask);
    expect(specializeBuiltinCli(ask, "unsupported")).toBe(ask);
    // A built-in that takes no CLI override is returned untouched.
    const terminal = BUILTIN_METHODS.find((method) => method.id === "terminal")!;
    expect(specializeBuiltinCli(terminal, "codex")).toBe(terminal);
  });
});
