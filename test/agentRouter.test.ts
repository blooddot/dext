import { describe, expect, it, vi } from "vitest";
import { DefaultAgentRunner } from "../src/core/agentRouter.js";
import { CliAgentRunner, type AgentConversationRequest } from "../src/core/agentRunner.js";
import { DeepSeekHarnessRunner } from "../src/core/deepseekHarnessRunner.js";
describe("Agent routing", () => {
  it("routes each supported backend explicitly and rejects unknown providers", async () => {
    const cli = new CliAgentRunner(), harness = new DeepSeekHarnessRunner();
    const cliRun = vi.spyOn(cli, "runConversation").mockResolvedValue("cli");
    const harnessRun = vi.spyOn(harness, "runConversation").mockResolvedValue("harness");
    const router = new DefaultAgentRunner(cli, harness);
    for (const provider of ["codex", "claude", "deepseek-harness"] as const) {
      const request: AgentConversationRequest = { profile: { id: provider, provider, label: provider, command: provider, models: [] }, input: "hello", mode: "ask", cwd: process.cwd(), allowWorkspaceWrite: false, metadata: {} };
      expect(await router.runConversation(request)).toBe(provider === "deepseek-harness" ? "harness" : "cli");
    }
    expect(cliRun).toHaveBeenCalledTimes(2); expect(harnessRun).toHaveBeenCalledOnce();
    expect(() => router.runConversation({ profile: { provider: "unknown" } } as unknown as AgentConversationRequest)).toThrow("Unsupported");
    const close = vi.spyOn(harness, "endSession"), dispose = vi.spyOn(harness, "dispose");
    router.endSession("one"); await router.dispose();
    expect(close).toHaveBeenCalledWith("one"); expect(dispose).toHaveBeenCalledOnce();
  });
});
