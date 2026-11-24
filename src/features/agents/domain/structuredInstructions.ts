/** Dext's instructions for one isolated API call. Caller rules, skills,
 * template fields and the schema travel with that call's data. */
export function structuredApiInstructions(format: "provider-schema" | "result-tool"): string {
  return [
    "Read the labeled Dext JSON payload. Use its instruction, arguments and context for this call. For values tagged kind=dext-result, inspect their value field.",
    "Report concise progress without exposing hidden reasoning.",
    format === "provider-schema"
      ? "The final agent message must contain only JSON matching the native structured-output schema."
      : "If the result is returned as a final message, return only one valid JSON object matching the supplied schema, without Markdown fences or surrounding text."
  ].join(" ");
}

export function structuredApiInput(data: string, inlineInstructions?: string): string {
  return inlineInstructions ? `Dext instruction source for this call: inline.\n${inlineInstructions}\n\n${data}` : data;
}

export function nativeStructuredApiInstructions(instructions: string): string {
  return `If this call declares an inline Dext instruction source, use that call's fixed Dext rules instead of this block. ${instructions}`;
}
