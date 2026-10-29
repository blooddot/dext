import { z } from "zod";

export const projectAvailabilitySchema = z.enum(["absent", "ready", "unavailable"]);
export const projectAssessmentSchema = z.enum(["none", "change", "unknown", "conflict"]);
export type ProjectAssessment = z.infer<typeof projectAssessmentSchema>;

export const projectBasisSchema = z.object({
  locator: z.string().min(1),
  id: z.string().min(1),
  hash: z.string().min(1),
  kind: z.enum(["object", "relation", "body", "applicability"])
}).strict();
export type ProjectBasis = z.infer<typeof projectBasisSchema>;

/** Model-authored statements carry references, never host-owned versions or authority. */
export const projectImpactSchema = z.object({
  assessment: projectAssessmentSchema,
  reason: z.string().trim().min(1).max(8000),
  refs: z.array(z.string().min(1)).max(500),
  coverage: z.enum(["complete", "partial", "unknown"])
}).strict().superRefine((value, context) => {
  if (value.assessment === "none" && (value.coverage !== "complete" || !value.refs.length)) {
    context.addIssue({ code: "custom", message: "A none assessment requires complete coverage and explicit references." });
  }
});
export type ProjectImpact = z.infer<typeof projectImpactSchema>;

export const projectDeltaSchema = z.object({
  op: z.enum(["create", "update", "delete", "none"]),
  target: z.string().min(1),
  id: z.string().min(1),
  beforeHash: z.string().nullable(),
  after: z.unknown().optional(),
  evidence: z.array(z.string().min(1)).min(1)
}).strict().superRefine((value, context) => {
  if ((value.op === "create" || value.op === "update") && value.after === undefined) {
    context.addIssue({ code: "custom", message: "A create or update requires after." });
  }
  if (value.op === "create" && value.beforeHash !== null) {
    context.addIssue({ code: "custom", message: "A create must expect an absent target." });
  }
  if ((value.op === "update" || value.op === "delete") && !value.beforeHash) {
    context.addIssue({ code: "custom", message: "An existing target requires beforeHash." });
  }
});
export type ProjectDelta = z.infer<typeof projectDeltaSchema>;

export const projectReviewReportSchema = z.object({
  ...projectImpactSchema.shape,
  checks: z.array(z.object({
    source: z.enum(["host_observed", "agent_reported", "manual"]),
    description: z.string().min(1),
    status: z.enum(["passed", "failed", "pending"])
  }).strict()).min(1),
  projectDelta: z.array(projectDeltaSchema)
}).strict().superRefine((value, context) => {
  const candidate = projectImpactSchema.safeParse({ assessment: value.assessment, reason: value.reason, refs: value.refs, coverage: value.coverage });
  if (!candidate.success) {
    context.addIssue({ code: "custom", message: "Invalid impact coverage." });
  }
  if (value.assessment === "none" && value.projectDelta.some(delta => delta.op !== "none")) {
    context.addIssue({ code: "custom", message: "A none assessment cannot change Project." });
  }
});
export type ProjectReviewReport = z.infer<typeof projectReviewReportSchema>;

export const planProjectContextSchema = z.object({
  workspaceKey: z.string().min(1),
  planPath: z.string().min(1),
  documentHash: z.string().min(1),
  fileHash: z.string().min(1),
  availability: projectAvailabilitySchema,
  assessment: projectAssessmentSchema,
  reason: z.string(),
  basis: z.array(projectBasisSchema),
  reviewStatus: z.enum(["pending", "current", "stale", "proposed", "reconciled"]),
  report: projectReviewReportSchema.optional(),
  evidenceId: z.string().optional(),
  receipts: z.array(z.object({ id: z.string(), status: z.enum(["applied", "rejected"]), afterHash: z.string().nullable() }).strict()).optional()
}).strict();
export type PlanProjectContext = z.infer<typeof planProjectContextSchema>;
