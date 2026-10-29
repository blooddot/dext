import { z } from "zod";
import { projectContextSchema, projectIntentSchema, projectQualityIssueSchema } from "../../contracts/projectIntent.js";

/**
 * A durable stage checkpoint for Project model generation.
 *
 * The AI pipeline can run for many minutes. Dext keeps the accepted output of each completed
 * stage so a paused run can continue instead of repeating the batches and reconciliations that
 * already succeeded. Responsibility batches are stored individually with the signature of the
 * exact model input that produced them: when only some sources changed, the batches built from
 * unchanged files are reused without another model call and only the affected batches are
 * regenerated. A checkpoint is reused only while its prompt/schema/index/AI settings still match;
 * otherwise it is discarded.
 */
export const PROJECT_MODEL_CHECKPOINT_VERSION = 2;

export type ProjectModelCheckpointStage = "batches" | "reconcile" | "review" | "overview" | "repair";

export const PROJECT_MODEL_CHECKPOINT_STAGES = ["batches", "reconcile", "review", "overview", "repair"] as const;

const fingerprintSchema = z.object({
  /** StructureSummary.hash: index version, every file path + SHA-256, config and indexing issues. */
  structureHash: z.string().min(1),
  structureVersion: z.number().int().positive(),
  indexVersion: z.number().int().positive(),
  /** Evidence package hash: selection, excerpts and the structure facts supplied to the model. */
  evidenceInputHash: z.string().min(1),
  promptVersion: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  /** Stable JSON of the selected Project AI CLI/model/reasoning/speed. */
  ai: z.string(),
  route: z.enum(["existing", "legacy", "documents", "code", "empty"]).optional(),
  baselineRevision: z.number().int().nonnegative().nullable().optional(),
  documentHashes: z.record(z.string(), z.string()).optional()
}).strict();

export type ProjectModelCheckpointFingerprint = z.infer<typeof fingerprintSchema>;

/**
 * One completed responsibility batch: the outline the model returned plus the identity of the
 * input that produced it. A resumed run rebuilds the batch list from the current sources and can
 * adopt a saved batch verbatim when both signatures are equal.
 */
const batchResultSchema = z.object({
  signature: z.string().min(1),
  drafts: z.array(projectContextSchema)
}).strict();

export type ProjectModelCheckpointBatch = z.infer<typeof batchResultSchema>;

const overviewSchema = z.object({
  intent: projectIntentSchema,
  model: z.string().optional()
}).strict();

export const projectModelCheckpointSchema = z.object({
  version: z.literal(PROJECT_MODEL_CHECKPOINT_VERSION),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  fingerprint: fingerprintSchema,
  /** The last stage whose complete output is stored. */
  stage: z.enum(PROJECT_MODEL_CHECKPOINT_STAGES),
  /** Completion of the AI phase at the checkpoint, 0..1; used to resume the progress bar. */
  fraction: z.number().min(0).max(1),
  /** Cumulative provider attempts across resumed runs. */
  attempts: z.number().int().nonnegative(),
  /** Completed responsibility batches, in batch order. */
  batches: z.array(batchResultSchema).optional(),
  reconcileRound: z.number().int().nonnegative().optional(),
  reconcileComplete: z.boolean().optional(),
  ownershipReviews: z.array(projectQualityIssueSchema).optional(),
  overview: overviewSchema.optional()
}).strict();

export type ProjectModelCheckpoint = z.infer<typeof projectModelCheckpointSchema>;

/** Persistence owned by the Project host; tests use an in-memory implementation. */
export interface ProjectInitializationCheckpointStore {
  read(): Promise<ProjectModelCheckpoint | undefined>;
  write(checkpoint: ProjectModelCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

function stageIndex(stage: ProjectModelCheckpointStage): number {
  return PROJECT_MODEL_CHECKPOINT_STAGES.indexOf(stage);
}

/** Whether a checkpoint was saved at or after `boundary`, so that stage can be skipped. */
export function checkpointReached(checkpoint: Pick<ProjectModelCheckpoint, "stage">, boundary: ProjectModelCheckpointStage): boolean {
  return stageIndex(checkpoint.stage) >= stageIndex(boundary);
}

export function projectModelCheckpointStageLabel(stage: ProjectModelCheckpointStage): string {
  switch (stage) {
    case "batches": return "responsibility batches";
    case "reconcile": return "directory reconciliation";
    case "review": return "ownership review";
    case "overview": return "project overview";
    case "repair": return "architecture review";
  }
}

/** Human-readable reasons a saved checkpoint can no longer describe the current run. */
const FINGERPRINT_FIELDS: readonly (readonly [keyof ProjectModelCheckpointFingerprint, string])[] = [
  ["structureHash", "project sources"],
  ["structureVersion", "structure schema"],
  ["indexVersion", "index version"],
  ["evidenceInputHash", "evidence package"],
  ["promptVersion", "prompt version"],
  ["schemaVersion", "output schema"],
  ["ai", "Project AI settings"], ["route", "initialization route"], ["baselineRevision", "Project baseline"], ["documentHashes", "adopted documents"]
];

export interface ProjectModelCheckpointMismatch {
  field: keyof ProjectModelCheckpointFingerprint;
  label: string;
}

/**
 * Which identity fields differ, so the output can say why a checkpoint was not resumed instead of
 * only announcing that "something" changed. An empty array means the checkpoint is reusable.
 */
export function projectModelCheckpointMismatch(
  saved: ProjectModelCheckpointFingerprint,
  current: ProjectModelCheckpointFingerprint
): ProjectModelCheckpointMismatch[] {
  return FINGERPRINT_FIELDS
    .filter(([field]) => JSON.stringify(saved[field]) !== JSON.stringify(current[field]))
    .map(([field, label]) => ({ field, label }));
}

/**
 * Only the indexed content changed (sources or the evidence trimmed from them). Completed
 * responsibility batches remain individually reusable when their own input signature still matches;
 * the later stages are global and are always regenerated.
 */
export function projectModelCheckpointContentOnly(mismatch: readonly ProjectModelCheckpointMismatch[]): boolean {
  return mismatch.length > 0 && mismatch.every(item => item.field === "structureHash" || item.field === "evidenceInputHash");
}

/** A checkpoint is reusable only when every identity field still matches the current run. */
export function projectModelCheckpointMatches(
  saved: ProjectModelCheckpointFingerprint,
  current: ProjectModelCheckpointFingerprint
): boolean {
  return projectModelCheckpointMismatch(saved, current).length === 0;
}
