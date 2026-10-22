/**
 * The Harness normalized-output channel.
 *
 * ACP's `PromptRequest` carries `sessionId`, `prompt` and `_meta` and nothing
 * else, so Dext cannot constrain a Harness answer the way it constrains Codex
 * (`--output-schema`) and Claude (`--json-schema`). Dext's own preset overlay
 * plugin already runs inside the Harness process, though, and the Harness tool
 * registry is a first-class structured channel: a tool's arguments are
 * losslessly materialized JSON, and a rejected call comes back to the model as
 * an ordinary `Error: <message>` result that does not end the turn.
 *
 * So Dext publishes one tool per turn whose argument schema *is* the call's
 * output contract, and validates every submission itself. The model then
 * repairs its own answer inside the turn instead of the turn failing on prose,
 * a fence or an escaped envelope.
 */

/** The one tool Dext registers in the Harness to carry a turn's result. */
export const HARNESS_RESULT_TOOL = "dext_submit_result";

/** What Dext publishes before prompting: the tool the model submits through,
 * with the current call's output contract as its argument schema. `undefined`
 * clears the registration at the end of the turn. */
export interface HarnessResultTool {
  name: string;
  description: string;
  /** Raw JSON Schema for the tool arguments (the call's output contract). */
  parameters: Record<string, unknown>;
}

/** One model submission as the overlay plugin forwards it. */
export interface HarnessResultRequest {
  id: string;
  args: unknown;
}

/** What Dext's validation did with one submission. `rejected` carries the
 * contract's own diagnostics, which the model reads as a normal tool error;
 * `unavailable` means no Dext turn is waiting for a result, which the plugin
 * reports as an error rather than accepting a value nobody will read. */
export type HarnessResultOutcome =
  | { status: "accepted" }
  | { status: "rejected"; diagnostics: string }
  | { status: "unavailable" };

const DESCRIPTION = [
  "Submit the final structured result for the current Dext call.",
  "Pass the complete result object itself as this tool's arguments, exactly as the required schema declares it.",
  "A result that does not match answers with the exact validation errors; fix the result and call the tool again.",
  "Do not wrap the result in an envelope and do not escape it as a string."
].join(" ");

/**
 * The instruction that makes the tool the primary answer channel. The prompt
 * still carries the schema and the final-message form as a fallback, because a
 * preset can restrict the tool away (Minimal allows two tools) and a turn must
 * then behave exactly as it did before this channel existed.
 */
export function harnessResultInstruction(): string {
  return [
    `Submit the result by calling the \`${HARNESS_RESULT_TOOL}\` tool, passing the result object itself as its arguments.`,
    "The tool answers with the exact errors if the result does not match; fix it and call the tool again.",
    `Only if \`${HARNESS_RESULT_TOOL}\` is unavailable, return the same object as your final message instead.`
  ].join(" ");
}

/**
 * The tool definition Dext publishes for one contract, or `undefined` when the
 * contract has no object root to submit against.
 *
 * The root `$schema` keyword `z.toJSONSchema` emits is dropped: it describes
 * the draft of the schema document rather than the arguments, and provider
 * function-calling schemas do not carry it.
 *
 * A function-calling tool's arguments must be one object, and the `ui` contracts
 * compile to a root `oneOf` (a value plus a cancellation arm) precisely so a
 * union cannot be mistaken for a fixed shape. Those calls therefore keep the
 * prompt-carried answer form instead of being offered a tool no provider could
 * map.
 */
export function harnessResultTool(outputJsonSchema: object): HarnessResultTool | undefined {
  const parameters = { ...outputJsonSchema } as Record<string, unknown>;
  delete parameters["$schema"];
  if (parameters["type"] !== "object") return undefined;
  return { name: HARNESS_RESULT_TOOL, description: DESCRIPTION, parameters };
}

/** Parse one submission frame from Dext's own overlay plugin. Anything else on
 * the channel is not a submission, so an unknown shape is rejected rather than
 * half-read. */
export function parseHarnessResultRequest(value: unknown): HarnessResultRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (frame.kind !== "submit" || typeof frame.id !== "string" || !frame.id) return undefined;
  if (!Object.hasOwn(frame, "args")) return undefined;
  return { id: frame.id, args: frame.args };
}
