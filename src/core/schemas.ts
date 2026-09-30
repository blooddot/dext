import { uiFormResultSchema } from "./uiForm.js";
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

/** `planPath` is deliberately absent: Dext attaches it after a Plan turn, so
 * advertising it in the contract would only invite an agent to invent one. */
export const askResultSchema = z.object({ kind: z.literal("ask"), text: z.string() });
export const planResultSchema = z.object({ kind: z.literal("plan"), text: z.string() });
export const skillResultSchema = z.object({ kind: z.literal("skill"), text: z.string() });
export const agentResultSchema = z.object({
  kind: z.literal("agent"),
  text: z.string(),
  summary: z.string().optional(),
  patch: z.lazy(() => patchResultSchema).optional(),
  files: z.array(codeRefResultSchema).optional()
}).strict();
/** The text Dext rendered from a template. Both the text and the absence of a
 * destination are deliberate: `template` never writes, so the caller decides
 * whether and where the text lands. */
export const templateResultSchema = z.object({
  kind: z.literal("template"),
  text: z.string()
}).strict();
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
const uiSelections = z.array(z.string().max(2000)).max(200).refine((items) => new Set(items).size === items.length, "Duplicate selections");
export const uiResultSchema = z.discriminatedUnion("type", [
  z.object({ kind: z.literal("ui"), type: z.literal("select"), selected: uiSelections }).strict(),
  z.object({ kind: z.literal("ui"), type: z.literal("radio"), selected: uiSelections.max(1), custom: z.string().max(20000).optional() }).strict()
    .refine((result) => !result.custom || !result.selected.length, "Radio options and custom answers are exclusive"),
  z.object({ kind: z.literal("ui"), type: z.literal("checkbox"), selected: uiSelections, custom: z.string().max(20000).optional() }).strict(),
  z.object({ kind: z.literal("ui"), type: z.literal("alert"), status: z.enum(["acknowledged", "dismissed"]) }).strict(),
  uiFormResultSchema,
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
/** `AgentResult.patch` and a turn review's changes; not an API output kind. */
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

const builtinDextResultSchema = z.discriminatedUnion("kind", [
  askResultSchema,
  planResultSchema,
  agentResultSchema,
  templateResultSchema,
  applyResultSchema,
  terminalResultSchema,
  skillResultSchema,
  uiResultSchema,
  mcpRawResultSchema
]);

/** Structured MCP tools use a method-specific `mcp.<server>.<tool>` kind. It
 * cannot be represented by the literal discriminators above, so keep a
 * permissive schema for that namespaced result while still rejecting arbitrary
 * objects passed where a Dext Result is required. */
const typedMcpResultSchema = z.object({
  kind: z.string().startsWith("mcp.")
}).passthrough();

export const dextResultSchema = z.union([builtinDextResultSchema, typedMcpResultSchema]);

export const executionStateSchema = z.enum(["success", "failed", "cancelled"]);

/**
 * A step as the kernel reports it: an API response, process output, or a failure. At
 * most one of `response` and `stream` may be present, and a stream step always belongs
 * to `stdout` or `stderr` under the name it prints to.
 */
export const dextWireStepSchema = z.object({
  method: z.string().min(1),
  state: executionStateSchema,
  response: z.unknown().optional(),
  stream: z.object({
    channel: z.enum(["stdout", "stderr"]),
    text: z.string()
  }).strict().optional(),
  error: z.string().optional(),
  assignment: z.string().optional()
}).strict().superRefine((step, context) => {
  const carried = [step.response, step.stream].filter((value) => value !== undefined).length;
  if (carried > 1) {
    context.addIssue({ code: "custom", message: "A step carries a response or a stream, never both." });
  }
  if (step.stream && (step.method !== step.stream.channel || step.state !== "success")) {
    context.addIssue({ code: "custom", message: "A stream step is named after its channel and always succeeds." });
  }
});
