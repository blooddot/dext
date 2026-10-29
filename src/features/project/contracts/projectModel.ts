import { z } from "zod";
import { knowledgeBodySchema, projectEvidenceSchema } from "./projectKnowledge.js";
import { projectIntentProvenanceSchema } from "./projectIntent.js";

export const projectNodeKindSchema = z.enum(["project", "feature", "module", "concept", "capability", "context", "flow", "step", "term", "constraint", "decision", "architecture", "contract", "person", "system", "container"]);
export const projectModelNodeSchema = z.object({
  id: z.string().min(1).max(512), kind: projectNodeKindSchema,
  title: z.string().min(1), canonicalName: z.string().min(1),
  body: knowledgeBodySchema, paths: z.array(z.string()).default([]),
  ...projectIntentProvenanceSchema.shape,
  /** Domain fields retained during migration; relationships live only in relations. */
  properties: z.record(z.string(), z.unknown()).default({})
}).strict();
export type ProjectModelNode = z.infer<typeof projectModelNodeSchema>;
export const projectModelRelationSchema = z.object({
  id: z.string().min(1), from: z.string().min(1), to: z.string().min(1),
  kind: z.enum(["contains", "depends_on", "related_to", "implements", "constrains", "flows_to", "maps_to", "decides", "communicates"]),
  description: z.string().default(""), evidence: z.array(projectEvidenceSchema).default([]),
  origin: projectIntentProvenanceSchema.shape.origin,
  review: projectIntentProvenanceSchema.shape.review,
  freshness: projectIntentProvenanceSchema.shape.freshness
}).strict();
export type ProjectModelRelation = z.infer<typeof projectModelRelationSchema>;
export const projectModelSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  nodes: z.array(projectModelNodeSchema).max(20_000), relations: z.array(projectModelRelationSchema).max(80_000),
  updatedAt: z.number().nonnegative(),
  migration: z.object({ sourceHash: z.string(), aliases: z.record(z.string(), z.string()), backup: z.string() }).strict().optional()
}).strict();
export type ProjectModel = z.infer<typeof projectModelSchema>;
