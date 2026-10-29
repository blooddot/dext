import type { DextResult, ExecutionMetadata, ResolvedInvocation, RuntimeResponse } from "../../../shared/contracts/types.js";
import type { ProjectPlanPort } from "../../project/contracts/projectPlan.js";

export interface ProjectAwareRuntime {
  setProjectPlanPort(port: ProjectPlanPort | undefined): void;
}

/** A deterministic built-in handler the runtime dispatches outside a provider. */
export type DeterministicHandler = (
  invocation: ResolvedInvocation
) => DextResult | Promise<DextResult>;

/** The provider-facing capability a caller may depend on without the runtime. */
export interface WorkflowRuntime {
  executeConversation(
    mode: "agent" | "ask" | "plan",
    input: string,
    metadata?: Readonly<ExecutionMetadata>
  ): Promise<RuntimeResponse>;

  executeStructuredJson(
    input: string,
    outputSchema: object,
    metadata?: Readonly<ExecutionMetadata>
  ): Promise<{ text: string; model?: string }>;
}
