/** Dext mounts one preset from the installed Harness catalog on every Harness
 * conversation, so the catalog is the only source of preset choices. A
 * conversation without a choice - a new one, or one persisted before presets
 * were mandatory - runs the Harness default. */
export const DEFAULT_HARNESS_PRESET = "standard";

/** An empty selection means "no choice yet" and never the raw ACP profile
 * composition: it reads back as the Harness default, both for menus and for the
 * preset Dext mounts. */
export function harnessPresetOrDefault(preset: string | undefined): string {
  return preset || DEFAULT_HARNESS_PRESET;
}

/**
 * The structured-result envelope every Harness Agent API call must obey.
 *
 * The Harness has no native output schema (ACP `PromptRequest` has no
 * output-schema field), so Dext states the contract in the prompt instead of
 * relying on the provider. The project's own rule text travels in the payload's
 * `instruction` field, above the payload and in a stronger voice, so a
 * trailing-only reminder loses that conflict in a long session and the model
 * answers in Markdown; the same constraint is therefore restated before and
 * after the payload. Escaping is spelled out because the whole answer has to
 * survive as one JSON string.
 */
export function harnessResultEnvelope(outputJsonSchema: unknown): string {
  return [
    "Your final message must be exactly one JSON object matching this schema:",
    JSON.stringify(outputJsonSchema),
    "Put your entire answer inside the object's \"text\" field, including every line and Markdown block.",
    "Escape every newline as \\n and every double quote as \\\" so the object is valid JSON.",
    "No markdown fence, and no character before or after the object."
  ].join("\n");
}
