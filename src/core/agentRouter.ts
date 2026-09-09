import { CliAgentRunner, type AgentConversationRequest, type AgentExecutionRequest, type AgentRunner } from "./agentRunner.js";
import { DeepSeekHarnessRunner } from "./deepseekHarnessRunner.js";
export class DefaultAgentRunner implements AgentRunner {
  constructor(private readonly cli = new CliAgentRunner(), readonly harness = new DeepSeekHarnessRunner()) {}
  setTimeouts(timeouts: { agentTimeoutMs?: number; agentIdleTimeoutMs?: number }): void {
    if (timeouts.agentTimeoutMs !== undefined) {
      this.cli.setTimeoutMs(timeouts.agentTimeoutMs);
      this.harness.setTimeoutMs(timeouts.agentTimeoutMs);
    }
    if (timeouts.agentIdleTimeoutMs !== undefined) {
      this.cli.setIdleTimeoutMs(timeouts.agentIdleTimeoutMs);
      this.harness.setIdleTimeoutMs(timeouts.agentIdleTimeoutMs);
    }
  }
  private runner(provider: string): CliAgentRunner | DeepSeekHarnessRunner {
    if (provider === "deepseek-harness") return this.harness;
    if (provider === "codex" || provider === "claude") return this.cli;
    throw new Error(`Unsupported Agent backend: ${provider}`);
  }
  run(request: AgentExecutionRequest): Promise<unknown> { return this.runner(request.profile.provider).run(request); }
  runConversation(request: AgentConversationRequest): Promise<string> { return this.runner(request.profile.provider).runConversation(request); }
  endSession(sessionId: string): void { this.harness.endSession(sessionId); }
  dispose(): Promise<void> { return this.harness.dispose(); }
}
