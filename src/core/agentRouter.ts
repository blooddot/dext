import { CliAgentRunner, type AgentConversationRequest, type AgentExecutionRequest, type AgentRunner, type AgentStructuredRequest } from "./agentRunner.js";
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
  private runner(provider: string): AgentRunner {
    if (provider === "deepseek-harness") return this.harness;
    if (provider === "codex" || provider === "claude") return this.cli;
    throw new Error(`Unsupported Agent backend: ${provider}`);
  }
  run(request: AgentExecutionRequest): Promise<unknown> { return this.runner(request.profile.provider).run(request); }
  runConversation(request: AgentConversationRequest): Promise<string> {
    const runner = this.runner(request.profile.provider);
    if (!runner.runConversation) throw new Error(`Agent '${request.profile.label}' does not support normal conversation mode.`);
    return runner.runConversation(request);
  }
  /** Only the CLI backends carry a schema through the provider's own structured
   * output channel; the Harness has no such field in ACP, so it is rejected here
   * rather than silently downgraded to a text prompt. */
  runStructured(request: AgentStructuredRequest): Promise<string> {
    const runner = this.runner(request.profile.provider);
    if (!runner.runStructured) {
      throw new Error(`Agent '${request.profile.label}' does not support the provider's native structured output.`);
    }
    return runner.runStructured(request);
  }
  endSession(sessionId: string): void { this.harness.endSession(sessionId); }
  dispose(): Promise<void> { return this.harness.dispose(); }
}
