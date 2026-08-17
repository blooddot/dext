import { z } from "zod";

const positionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative()
}).strict();

const rangeSchema = z.object({
  start: positionSchema,
  end: positionSchema
}).strict();

const codeRefResultSchema = z.object({
  kind: z.literal("codeRef"),
  uri: z.string(),
  range: rangeSchema.optional(),
  symbol: z.string().optional(),
  documentVersion: z.number().int(),
  contentHash: z.string(),
  content: z.string()
}).strict();

export const textResultSchema = z.object({ kind: z.literal("text"), text: z.string() });
export const codeResultSchema = z.object({
  kind: z.literal("code"),
  code: z.string(),
  language: z.string(),
  title: z.string().optional()
});
export const reviewResultSchema = z.object({
  kind: z.literal("review"),
  status: z.enum(["pass", "warning", "fail"]),
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(["error", "warning", "info"]),
      message: z.string(),
      uri: z.string().optional(),
      line: z.number().int().nonnegative().optional()
    })
  )
});
export const chatResultSchema = z.object({ kind: z.literal("chat"), text: z.string() });
export const agentResultSchema = z.object({
  kind: z.literal("agent"),
  text: z.string(),
  summary: z.string().optional(),
  patch: z.lazy(() => patchResultSchema).optional(),
  files: z.array(codeRefResultSchema).optional()
}).strict();
export const explainResultSchema = z.object({
  kind: z.literal("explain"),
  text: z.string(),
  files: z.array(codeRefResultSchema)
});
export const editResultSchema = z.object({
  kind: z.literal("edit"),
  summary: z.string(),
  patch: z.lazy(() => patchResultSchema),
  files: z.array(codeRefResultSchema)
});
export const applyResultSchema = z.object({
  kind: z.literal("apply"),
  status: z.enum(["applied", "unchanged", "conflict"]),
  files: z.array(codeRefResultSchema),
  summary: z.string()
});
export const terminalResultSchema = z.object({
  kind: z.literal("terminal"),
  status: z.enum(["succeeded", "failed", "timed_out"]),
  command: z.string(),
  cwd: z.string(),
  exit_code: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  duration_ms: z.number().nonnegative()
});
export const printResultSchema = z.object({
  kind: z.literal("print"),
  text: z.string(),
  label: z.string().optional()
}).strict();
export const uiResultSchema = z.discriminatedUnion("type", [
  z.object({ kind: z.literal("ui"), type: z.literal("choice"), selected: z.array(z.string()), custom: z.string().optional() }).strict(),
  z.object({ kind: z.literal("ui"), type: z.literal("confirm"), confirmed: z.boolean() }).strict(),
  z.object({ kind: z.literal("ui"), type: z.literal("input"), value: z.string().optional() }).strict()
]);
export const mcpRawResultSchema = z.object({
  kind: z.literal("mcpRaw"),
  server: z.string(),
  tool: z.string(),
  content: z.string().optional(),
  structured: z.record(z.string(), z.unknown()).optional()
}).strict();
export const planResultSchema = z.object({
  kind: z.literal("plan"),
  title: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      detail: z.string().optional(),
      status: z.enum(["pending", "ready"])
    })
  )
});
export const patchResultSchema = z.object({
  kind: z.literal("patch"),
  title: z.string(),
  changes: z.array(
    z.object({
      uri: z.string(),
      before: z.string(),
      after: z.string(),
      range: rangeSchema.optional(),
      documentVersion: z.number().int().optional(),
      contentHash: z.string().optional()
    })
  )
});

export const dextResultSchema = z.discriminatedUnion("kind", [
  chatResultSchema,
  agentResultSchema,
  explainResultSchema,
  editResultSchema,
  textResultSchema,
  codeResultSchema,
  reviewResultSchema,
  planResultSchema,
  patchResultSchema,
  applyResultSchema,
  terminalResultSchema,
  printResultSchema,
  uiResultSchema,
  mcpRawResultSchema
]);
