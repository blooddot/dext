import { describe, expect, it, vi } from "vitest";
import { DefaultAgentRunner } from "../src/features/agents/host/agentRouter.js";
import { CliAgentRunner, type AgentConversationRequest } from "../src/features/agents/host/agentRunner.js";
import { DeepSeekHarnessRunner } from "../src/features/agents/host/deepseekHarnessRunner.js";
import { PiAgentRunner } from "../src/features/agents/host/piAgentRunner.js";
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
});
