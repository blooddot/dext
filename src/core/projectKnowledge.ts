import { z } from "zod";

/** Where a project object came from. Independent from whether a user confirmed it. */
export const knowledgeSourceSchema = z.enum(["code", "ai", "user"]);
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

/** User confirmation state. An accepted object stays accepted even when it later needs review. */
export const knowledgeConfirmationSchema = z.enum(["draft", "accepted", "rejected"]);
export type KnowledgeConfirmation = z.infer<typeof knowledgeConfirmationSchema>;

/** Whether the object still represents the current code. Tracked separately from confirmation. */
export const knowledgeValiditySchema = z.enum(["current", "needs_verification", "stale", "conflicted"]);
export type KnowledgeValidity = z.infer<typeof knowledgeValiditySchema>;

/** How the object is owned by the project: one module, several, a candidate, or nobody yet. */
export const knowledgeOwnershipSchema = z.enum(["owned", "shared", "candidate", "unassigned"]);
export type KnowledgeOwnership = z.infer<typeof knowledgeOwnershipSchema>;

/** Legacy single-axis status kept only so pre-existing stored objects still parse. */
export const knowledgeLegacyStatusSchema = z.enum(["detected", "inferred", "accepted", "stale", "conflicted", "unassigned", "unknown"]);
export type KnowledgeLegacyStatus = z.infer<typeof knowledgeLegacyStatusSchema>;

export const projectEvidenceSchema = z.object({
  path: z.string().min(1),
  symbol: z.string().optional(),
  contentHash: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  /** Parser coverage marks, e.g. "typescript/compiler" or "rust/dynamic-macro". */
  coverage: z.string().optional(),
  /** Why a fact could not be proven, kept alongside the evidence instead of being dropped. */
  uncertainty: z.string().optional(),
  note: z.string().optional()
}).strict();
export type ProjectEvidence = z.infer<typeof projectEvidenceSchema>;

export const projectObjectSchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().regex(/^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/),
  displayName: z.string().min(1).optional(),
  aliases: z.array(z.string().min(1)).default([]),
  kind: z.enum(["feature", "module", "concept"]),
  description: z.string().default(""),
  behavior: z.array(z.string()).default([]),
  paths: z.array(z.string().min(1)).default([]),
  relatedIds: z.array(z.string().min(1)).default([]),
  source: knowledgeSourceSchema,
  confirmation: knowledgeConfirmationSchema.default("draft"),
  validity: knowledgeValiditySchema.default("current"),
  ownership: knowledgeOwnershipSchema.default("unassigned"),
  confidence: z.number().min(0).max(1).default(0),
  evidence: z.array(projectEvidenceSchema).default([]),
  version: z.number().int().nonnegative().default(0),
  status: knowledgeLegacyStatusSchema.optional()
}).strict();
export type ProjectObject = z.infer<typeof projectObjectSchema>;

export const projectKnowledgeSchema = z.object({
  schemaVersion: z.literal(1),
  objects: z.array(projectObjectSchema),
  updatedAt: z.number().int().nonnegative()
}).strict();
export type ProjectKnowledge = z.infer<typeof projectKnowledgeSchema>;

function legacyConfirmation(status: KnowledgeLegacyStatus | undefined): KnowledgeConfirmation | undefined {
  if (!status) return undefined;
  // A legacy stale/conflicted object had already been accepted; the change is about validity.
  return status === "accepted" || status === "stale" || status === "conflicted" ? "accepted" : "draft";
}

function legacyValidity(status: KnowledgeLegacyStatus | undefined): KnowledgeValidity | undefined {
  if (!status) return undefined;
  if (status === "stale") return "stale";
  if (status === "conflicted") return "conflicted";
  return "current";
}

function legacyOwnership(status: KnowledgeLegacyStatus | undefined): KnowledgeOwnership | undefined {
  return status === "unassigned" ? "unassigned" : status ? "candidate" : undefined;
}

/**
 * Parses a project object and, when a legacy `status` is present, fills the independent
 * source/confirmation/validity/ownership dimensions without overwriting explicit values.
 */
export function normalizeProjectObject(input: unknown): ProjectObject {
  const raw = (input ?? {}) as Record<string, unknown>;
  const parsed = projectObjectSchema.parse(input);
  const legacy = parsed.status;
  const explicit = (key: string): boolean => typeof raw[key] === "string";
  return {
    ...parsed,
    ...(explicit("confirmation") ? {} : { confirmation: legacyConfirmation(legacy) ?? parsed.confirmation }),
    ...(explicit("validity") ? {} : { validity: legacyValidity(legacy) ?? parsed.validity }),
    ...(explicit("ownership") ? {} : { ownership: legacyOwnership(legacy) ?? parsed.ownership })
  };
}

export function searchableProjectObjectValues(object: ProjectObject): string[] {
  return [object.canonicalName, object.displayName ?? "", ...object.aliases]
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean);
}

/** An accepted object can move to needs_verification or stale without losing its acceptance. */
export function isAcceptedObject(object: Pick<ProjectObject, "confirmation">): boolean {
  return object.confirmation === "accepted";
}

export function validateProjectObjects(objects: readonly ProjectObject[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const object of objects) {
    if (ids.has(object.id)) errors.push(`Duplicate project object id '${object.id}'.`);
    ids.add(object.id);
    for (const name of searchableProjectObjectValues(object)) {
      const previous = names.get(name);
      if (previous && previous !== object.id) errors.push(`Project object name or alias '${name}' is used by '${previous}' and '${object.id}'.`);
      names.set(name, object.id);
    }
  }
  const known = new Set(objects.map((object) => object.id));
  for (const object of objects) for (const related of object.relatedIds) {
    if (!known.has(related)) errors.push(`Project object '${object.id}' references missing object '${related}'.`);
  }
  return errors;
}
