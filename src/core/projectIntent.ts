import { z } from "zod";
import { projectEvidenceSchema } from "./projectKnowledge.js";
import type { ProjectEvidence } from "./projectKnowledge.js";

/** Provenance of a semantic statement in the Project model. */
export const projectIntentOriginSchema = z.enum(["detected", "inferred", "declared", "accepted"]);
export type ProjectIntentOrigin = z.infer<typeof projectIntentOriginSchema>;

/** Review state is deliberately independent from provenance and freshness. */
export const projectIntentReviewSchema = z.enum(["draft", "accepted", "rejected", "edited"]);
export type ProjectIntentReview = z.infer<typeof projectIntentReviewSchema>;

export const projectIntentFreshnessSchema = z.enum(["current", "needs_verification", "stale", "conflicted"]);
export type ProjectIntentFreshness = z.infer<typeof projectIntentFreshnessSchema>;

const confidence = z.number().min(0).max(1).default(0);
const evidence = z.array(projectEvidenceSchema).default([]);
const provenance = z.object({
  origin: projectIntentOriginSchema.default("inferred"),
  review: projectIntentReviewSchema.default("draft"),
  freshness: projectIntentFreshnessSchema.default("current"),
  confidence,
  evidence,
  inputHash: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  generatedAt: z.number().int().nonnegative().optional(),
  promptVersion: z.string().min(1).optional(),
  schemaVersion: z.string().min(1).optional()
}).strict();
export const projectIntentProvenanceSchema = provenance;
export type ProjectIntentProvenance = z.infer<typeof provenance>;

export const projectCapabilitySchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().default(""),
  outcomes: z.array(z.string().min(1)).default([]),
  contextIds: z.array(z.string().min(1)).default([]),
  moduleIds: z.array(z.string().min(1)).default([]),
  ...provenance.shape
}).strict();
export type ProjectCapability = z.infer<typeof projectCapabilitySchema>;

export const projectArchitectureContextSchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  displayName: z.string().min(1).optional(),
  purpose: z.string().default(""),
  responsibilities: z.array(z.string().min(1)).default([]),
  moduleIds: z.array(z.string().min(1)).default([]),
  entryPoints: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  relatedContextIds: z.array(z.string().min(1)).default([]),
  ...provenance.shape
}).strict();
export type ProjectArchitectureContext = z.infer<typeof projectArchitectureContextSchema>;
/** Short alias used by UI and adapter code when referring to a bounded context. */
export const projectContextSchema = projectArchitectureContextSchema;
export type ProjectContext = ProjectArchitectureContext;

export const projectFlowStepSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  actor: z.string().min(1).optional(),
  contextId: z.string().min(1).optional(),
  moduleId: z.string().min(1).optional(),
  nextStepIds: z.array(z.string().min(1)).default([]),
  evidence
}).strict();
export type ProjectFlowStep = z.infer<typeof projectFlowStepSchema>;

export const projectFlowSchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  displayName: z.string().min(1).optional(),
  description: z.string().default(""),
  trigger: z.string().min(1).optional(),
  steps: z.array(projectFlowStepSchema).default([]),
  outcomes: z.array(z.string().min(1)).default([]),
  ...provenance.shape
}).strict();
export type ProjectFlow = z.infer<typeof projectFlowSchema>;

export const projectTermSchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  displayName: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).default([]),
  forbiddenNames: z.array(z.string().min(1)).default([]),
  definition: z.string().default(""),
  contextIds: z.array(z.string().min(1)).default([]),
  ...provenance.shape
}).strict();
export type ProjectTerm = z.infer<typeof projectTermSchema>;

export const projectConstraintSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().default(""),
  scope: z.array(z.string().min(1)).default([]),
  ...provenance.shape
}).strict();
export type ProjectConstraint = z.infer<typeof projectConstraintSchema>;

export const projectDecisionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  decision: z.string().min(1),
  alternatives: z.array(z.string().min(1)).default([]),
  consequences: z.array(z.string().min(1)).default([]),
  ...provenance.shape
}).strict();
export type ProjectDecision = z.infer<typeof projectDecisionSchema>;

export const projectBriefSchema = z.object({
  name: z.string().min(1),
  summary: z.string().default(""),
  goals: z.array(z.string().min(1)).default([]),
  runtime: z.array(z.string().min(1)).default([]),
  audiences: z.array(z.string().min(1)).default([]),
  ...provenance.shape
}).strict();
export type ProjectBrief = z.infer<typeof projectBriefSchema>;

/** Versioned, persisted semantic model owned by Project (never by a diagram adapter). */
export const projectIntentSchema = z.object({
  schemaVersion: z.literal(1),
  brief: projectBriefSchema,
  capabilities: z.array(projectCapabilitySchema).default([]),
  contexts: z.array(projectArchitectureContextSchema).default([]),
  flows: z.array(projectFlowSchema).default([]),
  terms: z.array(projectTermSchema).default([]),
  constraints: z.array(projectConstraintSchema).default([]),
  decisions: z.array(projectDecisionSchema).default([]),
  inputHash: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  generatedAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative()
}).strict();
export type ProjectIntent = z.infer<typeof projectIntentSchema>;
/** Explicit document alias for callers persisting the model to `.dext`. */
export const projectIntentDocumentSchema = projectIntentSchema;
export type ProjectIntentDocument = ProjectIntent;

export interface ProjectIntentValidationError {
  path: string;
  message: string;
}

/** Validates cross-object references after the individual zod schemas have parsed. */
export function validateProjectIntent(intent: ProjectIntent): ProjectIntentValidationError[] {
  const errors: ProjectIntentValidationError[] = [];
  const ids = new Map<string, string>();
  const collections: Array<[string, readonly { id: string }[]]> = [
    ["capabilities", intent.capabilities], ["contexts", intent.contexts], ["flows", intent.flows],
    ["terms", intent.terms], ["constraints", intent.constraints], ["decisions", intent.decisions]
  ];
  for (const [collection, values] of collections) for (const item of values) {
    const previous = ids.get(item.id);
    if (previous) errors.push({ path: `${collection}.${item.id}`, message: `Duplicate intent id '${item.id}' (already used by ${previous}).` });
    else ids.set(item.id, `${collection}.${item.id}`);
  }
  const knownContexts = new Set(intent.contexts.map((item) => item.id));
  const check = (path: string, id: string, allowed: ReadonlySet<string>): void => { if (!allowed.has(id)) errors.push({ path, message: `References missing intent id '${id}'.` }); };
  intent.capabilities.forEach((item, i) => item.contextIds.forEach((id, j) => check(`capabilities.${i}.contextIds.${j}`, id, knownContexts)));
  intent.contexts.forEach((item, i) => [...item.dependsOn, ...item.relatedContextIds].forEach((id, j) => check(`contexts.${i}.references.${j}`, id, knownContexts)));
  intent.flows.forEach((flow, i) => {
    const stepIds = new Set<string>();
    flow.steps.forEach((step, j) => {
      if (stepIds.has(step.id)) errors.push({ path: `flows.${i}.steps.${j}.id`, message: `Duplicate flow step id '${step.id}'.` });
      stepIds.add(step.id);
      if (step.contextId) check(`flows.${i}.steps.${j}.contextId`, step.contextId, knownContexts);
      step.nextStepIds.forEach((id, k) => {
        if (!stepIds.has(id) && !flow.steps.some((candidate) => candidate.id === id)) errors.push({ path: `flows.${i}.steps.${j}.nextStepIds.${k}`, message: `References missing flow step '${id}'.` });
      });
    });
  });
  intent.terms.forEach((item, i) => item.contextIds.forEach((id, j) => check(`terms.${i}.contextIds.${j}`, id, knownContexts)));
  return errors;
}

/** Parses and validates both schema shape and references in one operation. */
export function parseProjectIntent(input: unknown): ProjectIntent {
  const parsed = projectIntentSchema.parse(input);
  const errors = validateProjectIntent(parsed);
  if (errors.length) throw new Error(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
  return parsed;
}

/** Collects all source evidence from the semantic model for diagnostics and indexing. */
export function projectIntentEvidence(intent: ProjectIntent): ProjectEvidence[] {
  return [intent.brief, ...intent.capabilities, ...intent.contexts, ...intent.flows, ...intent.terms, ...intent.constraints, ...intent.decisions]
    .flatMap((item) => item.evidence);
}
