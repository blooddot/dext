import { AioaCdpAgentRunner } from "./aioaCdp.js";
import { CliAgentRunner, type AgentExecutionRequest, type AgentRunner } from "./agentRunner.js";

/** Routes AIOA CDP requests without changing the existing CLI adapters. */
export class DefaultAgentRunner implements AgentRunner {
  constructor(
    private readonly cli = new CliAgentRunner(),
    private readonly aioa = new AioaCdpAgentRunner()
  ) {}

  run(request: AgentExecutionRequest): Promise<unknown> {
    return request.profile.provider === "aioa" ? this.aioa.run(request) : this.cli.run(request);
  }

  endSession(sessionId: string): void {
    this.aioa.endSession(sessionId);
  }
}
