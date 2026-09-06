import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/agentProfiles.js";
import { BUILTIN_METHODS } from "../src/core/builtins.js";
import { ContextResolver } from "../src/core/contextResolver.js";
import { DextLanguageService } from "../src/core/languageService.js";
import { MethodRegistry } from "../src/core/registry.js";
import { DextRuntime } from "../src/core/runtime.js";
import { compileWorkflow } from "../src/core/workflow.js";
import { WorkflowRuntime } from "../src/core/workflowRuntime.js";
import type { AgentConversationRequest, AgentExecutionRequest } from "../src/core/agentRunner.js";
import type { ExecutionMetadata, InvocationValue } from "../src/core/types.js";

const profiles: AgentProfile[] = [
  { id: "codex", provider: "codex", command: "codex", label: "Codex", models: ["gpt-test", "gpt-other"] },
  { id: "claude", provider: "claude", command: "claude", label: "Claude", models: ["sonnet", "opus"] }
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
  return { registry, runtime, requests, execute, language: new DextLanguageService(registry) };
}

describe("per-call built-in CLI options", () => {
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
    await execute({ cli: "claude" });
    expect(requests[2]?.model || undefined).toBeUndefined();
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
    { cli: "aioa" },
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

  it("passes create options to the host's subsequent conversation request", async () => {
    const { execute, runtime } = setup();
    const requests: AgentConversationRequest[] = [];
    runtime.setAgentRunner({
      run: async () => { throw new Error("create must use the host handler"); },
      runConversation: async (request) => { requests.push(request); return "created"; }
    });
    runtime.setCreateHandler(async (request) => {
      const input = request.arguments.input;
      if (typeof input !== "string") throw new Error("create input must be a string");
      return (await runtime.executeConversation("ask", input, request.metadata)).result;
    });
    await execute({ type: "rule", cli: "claude", model: "opus" }, "create");
    expect(requests[0]).toMatchObject({ profile: { id: "claude" }, model: "opus", permission: "read-only" });
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[0]?.speed).toBeUndefined();
    expect(requests[0]?.serviceTier).toBeUndefined();
  });

  it("does not borrow composer settings from a different decorator-selected CLI", async () => {
    const { execute, requests } = setup();
    await execute({ cli: "claude" }, "ask", { agent: "claude" });
    expect(requests[0]?.model || undefined).toBeUndefined();
    expect(requests[0]?.reasoningEffort).toBeUndefined();
    expect(requests[0]?.speed).toBeUndefined();
  });

  it("compiles and runs dynamic CLI/model values in a workflow", async () => {
    const { registry, runtime, requests } = setup();
    const source = 'provider = "codex"\noptions = {"model": "gpt-test", "reasoning": "max", "speed": "fast"}\nask(input="test", cli=provider, model=options)';
    const compiled = compileWorkflow(source, registry);
    expect(compiled.diagnostics).toEqual([]);
    await new WorkflowRuntime(runtime).execute(compiled.program!);
    expect(requests[0]).toMatchObject({ model: "gpt-test", reasoningEffort: "max", speed: "fast" });
  });

  it("checks literal options regardless of argument order", () => {
    const { registry } = setup();
    expect(compileWorkflow('ask(input="x", model="sonnet", cli="claude")', registry).diagnostics).toEqual([]);
    for (const source of [
      'ask(input="x", model="sonnet", cli="codex")',
      'ask(input="x", cli="claude", model="gpt-test")',
      'ask(input="x", cli="codex", model={"model":"gpt-test", "speed":"turbo"})'
    ]) expect(compileWorkflow(source, registry).diagnostics.some((item) => item.severity === "error")).toBe(true);
  });

  it("offers CLI-dependent enum values, Codex dictionary keys, and signatures", () => {
    const { language } = setup();
    const labels = (source: string) => language.documentCompletions(source).map((item) => item.label);
    expect(labels('ask(cli=')).toEqual(["codex", "claude"]);
    expect(labels('ask(cli="claude", model=')).toEqual(["sonnet", "opus"]);
    expect(labels('ask(cli="codex", model={')).toEqual(["model", "reasoning", "speed"]);
    expect(labels('ask(cli="codex", model={"model": ')).toEqual(["gpt-test", "gpt-other"]);
    expect(labels('ask(cli="codex", model={"model": "gpt-test", "reasoning": ')).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(labels('ask(cli="codex", model={"model": "gpt-test", "speed": ')).toEqual(["standard", "fast"]);
    expect(labels('ask(input="pretend cli=codex", cli="claude", model=')).toEqual(["sonnet", "opus"]);
    expect(language.documentSignature('ask(cli="claude", model=')?.parameters.at(-1)?.label).toBe('model?: "sonnet" | "opus"');
    expect(language.documentSignature('ask(cli="codex", model=')?.parameters.at(-1)?.label).toContain('model?: { model: "gpt-test" | "gpt-other"');
  });

  it("refreshes model choices when configured profiles change", () => {
    const { runtime, language } = setup();
    const source = 'ask(input="x", cli="codex", model={"model":"new-model"})';
    expect(language.inputDocument(source).kind).toBe("invalid");
    runtime.setAgentProfiles([{ ...profiles[0]!, models: ["new-model"] }]);
    expect(language.documentCompletions('ask(cli="codex", model={"model": ').map((item) => item.label)).toEqual(["new-model"]);
    expect(language.inputDocument(source).kind).toBe("workflow");
    runtime.setAgentProfiles(profiles);
    expect(language.inputDocument(source).kind).toBe("invalid");
  });
});
