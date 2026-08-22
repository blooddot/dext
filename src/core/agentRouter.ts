import { AioaCdpAgentRunner, type AioaCdpConnection } from "./aioaCdp.js";
import {
  CliAgentRunner,
  type AgentConversationRequest,
  type AgentExecutionRequest,
  type AgentRunner
} from "./agentRunner.js";

/** Routes AIOA CDP requests without changing the existing CLI adapters. */
export class DefaultAgentRunner implements AgentRunner {
  constructor(
    private readonly cli = new CliAgentRunner(),
    connection?: AioaCdpConnection
  ) {
    this.aioa = new AioaCdpAgentRunner(connection);
  }

  private readonly aioa: AioaCdpAgentRunner;

  setTimeouts(timeouts: {
    agentTimeoutMs?: number;
    aioaTimeoutMs?: number;
    aioaIdleTimeoutMs?: number;
  }): void {
    if (timeouts.agentTimeoutMs !== undefined) this.cli.setTimeoutMs(timeouts.agentTimeoutMs);
    this.aioa.setTimeouts({
      ...(timeouts.aioaTimeoutMs === undefined ? {} : { timeoutMs: timeouts.aioaTimeoutMs }),
      ...(timeouts.aioaIdleTimeoutMs === undefined
        ? {}
        : { responseIdleTimeoutMs: timeouts.aioaIdleTimeoutMs })
    });
  }

  run(request: AgentExecutionRequest): Promise<unknown> {
    return request.profile.provider === "aioa" ? this.aioa.run(request) : this.cli.run(request);
  }

  runConversation(request: AgentConversationRequest): Promise<string> {
    return request.profile.provider === "aioa"
      ? this.aioa.runConversation(request)
      : this.cli.runConversation(request);
  }

  endSession(sessionId: string): void {
    this.aioa.endSession(sessionId);
  }
}
