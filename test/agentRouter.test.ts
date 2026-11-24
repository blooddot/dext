import { describe, expect, it, vi } from "vitest";
import { DefaultAgentRunner } from "../src/features/agents/host/agentRouter.js";
import { CliAgentRunner, type AgentConversationRequest } from "../src/features/agents/host/agentRunner.js";
import { DeepSeekHarnessRunner } from "../src/features/agents/host/deepseekHarnessRunner.js";
import { PiAgentRunner } from "../src/features/agents/host/piAgentRunner.js";
import { conversationInstructionDelivery } from "../src/features/agents/domain/conversationInstructions.js";
describe("Agent routing", () => {
  it("routes each supported backend explicitly and rejects unknown providers", async () => {
    const cli = new CliAgentRunner(), harness = new DeepSeekHarnessRunner();
    const cliRun = vi.spyOn(cli, "runConversation").mockResolvedValue("cli");
    const harnessRun = vi.spyOn(harness, "runConversation").mockResolvedValue("harness");
    const pi = new PiAgentRunner();
    const piRun = vi.spyOn(pi, "runConversation").mockResolvedValue("pi");
    const router = new DefaultAgentRunner(cli, harness, pi);
    for (const provider of ["codex", "claude", "deepseek-harness", "pi"] as const) {
      const request: AgentConversationRequest = { profile: { id: provider, provider, label: provider, command: provider, models: [] }, input: "hello", mode: "ask", cwd: process.cwd(), allowWorkspaceWrite: false, metadata: {} };
      expect(await router.runConversation(request)).toBe(provider === "deepseek-harness" ? "harness" : provider === "pi" ? "pi" : "cli");
    }
    expect(cliRun).toHaveBeenCalledTimes(2); expect(harnessRun).toHaveBeenCalledOnce();
    expect(piRun).toHaveBeenCalledOnce();
    expect(() => router.runConversation({ profile: { provider: "unknown" } } as unknown as AgentConversationRequest)).toThrow("Unsupported");
    const close = vi.spyOn(harness, "endSession"), dispose = vi.spyOn(harness, "dispose");
    const piClose = vi.spyOn(pi, "endSession"), piDispose = vi.spyOn(pi, "dispose");
    router.endSession("one"); await router.dispose();
    expect(close).toHaveBeenCalledWith("one"); expect(dispose).toHaveBeenCalledOnce();
    expect(piClose).toHaveBeenCalledWith("one"); expect(piDispose).toHaveBeenCalledOnce();
  });

  it("leaves native delivery to the actual path, with a single source and turn-local language overrides", async () => {
    const cli = new CliAgentRunner();
    const deliveries: ReturnType<typeof conversationInstructionDelivery>[] = [];
    const run = vi.spyOn(cli, "runConversation").mockImplementation(async (request) => {
      const baseline = request.metadata.conversationInstructionBaseline;
      const resumeId = request.metadata.conversationProviderSessionId;
      const native = resumeId ? (baseline?.sessionId === resumeId ? baseline : undefined) : "install";
      deliveries.push(conversationInstructionDelivery(request.input, request.conversationInstructions, native));
      return "ok";
    });
    const router = new DefaultAgentRunner(cli);
    const input = 'Available conversation Skills (JSON metadata):\n[{"name":"Review"}]\n\nTask';
    const request: AgentConversationRequest = {
      profile: { id: "codex", provider: "codex", label: "Codex", command: "codex", models: [] },
      mode: "ask", cwd: process.cwd(), allowWorkspaceWrite: false, input,
      conversationInstructions: { outputLanguage: "zh-CN" }, metadata: {}
    };
    await router.runConversation(request);
    const initial = deliveries[0]!;
    expect(initial.input).toBe(input);
    expect(initial.nativeInstructions).toContain("Simplified Chinese (zh-CN)");
    expect(initial.nativeInstructions).not.toContain("Review");
    expect(initial.baseline).toMatchObject({ version: expect.any(Number), outputLanguage: "zh-CN" });
    const metadata = {
      conversationProviderSessionId: "thread",
      conversationInstructionBaseline: { ...initial.baseline!, sessionId: "thread" }
    };
    await router.runConversation({ ...request, metadata });
    await router.runConversation({ ...request, metadata, conversationInstructions: { outputLanguage: "en" } });
    await router.runConversation({ ...request, metadata, conversationInstructions: { outputLanguage: null } });
    await router.runConversation({ ...request, metadata: { conversationProviderSessionId: "legacy" } });
    expect(deliveries[1]?.input).toBe(input);
    expect(deliveries[2]?.input).toBe(`Dext conversation language override: Use English (en) for user-facing text.\n\n${input}`);
    expect(deliveries[3]?.input).toContain("Clear Dext's language preference");
    expect(deliveries.slice(1).every((delivery) => !delivery.nativeInstructions)).toBe(true);
    expect(deliveries[4]?.input).toContain("Dext instruction source for this turn: inline.");
    expect(deliveries[4]?.input).toContain("Simplified Chinese (zh-CN)");
    expect(run).toHaveBeenCalledTimes(5);
  });
});
