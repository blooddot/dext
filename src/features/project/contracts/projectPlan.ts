import type { PlanProjectContext, ProjectBasis, ProjectImpact } from "../../../shared/contracts/planProject.js";

export interface ProjectPlanRequest {
  workspaceKey: string;
  input: string;
  paths?: string[];
}

export interface ProjectPlanRead {
  availability: "absent" | "ready" | "unavailable";
  workspaceKey: string;
  basis: ProjectBasis[];
  grounding: string;
  diagnostics: string[];
  omitted: string[];
}

/** Project owns this port; callers do not know which persisted format supplies it. */
export interface ProjectPlanPort {
  readPlanContext(request: ProjectPlanRequest): Promise<ProjectPlanRead>;
  bindPlan(read: ProjectPlanRead, planPath: string, document: string, impact?: ProjectImpact): PlanProjectContext;
  validatePlan(context: PlanProjectContext, document: string, options?: { basis?: boolean }): Promise<{ valid: boolean; diagnostics: string[] }>;
}
