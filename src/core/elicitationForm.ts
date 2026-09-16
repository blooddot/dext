import type { AgentInputAnswers, AgentInputQuestion } from "./types.js";

/** One declared choice, with the wire value its label stands for. */
interface ElicitationChoice { label: string; description: string; value: string }
/** An elicitation answer batch. ACP and Claude Code both speak this shape. */
export type ElicitationFormResult =
  | { action: "accept"; content: Record<string, string | number | boolean | string[]> }
  | { action: "decline" }
  | { action: "cancel" };

const MAX_FIELDS = 20;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A form field's declared choices, or undefined when it declares none.
 * Fields are read as raw records: every known schema variant carries an index
 * signature for vendor payloads, so a discriminant alone never narrows one. */
function propertyChoices(property: Record<string, unknown>): ElicitationChoice[] | undefined {
  const titled = (options: unknown[]): ElicitationChoice[] => options.flatMap((option) => {
    const entry = record(option);
    const label = text(entry?.title);
    return label ? [{ label, description: text(entry?.description), value: text(entry?.const) || label }] : [];
  });
  const untitled = (values: unknown[]): ElicitationChoice[] =>
    values.filter((value): value is string => typeof value === "string").map((value) => ({ label: value, description: "", value }));
  if (property.type === "string") {
    if (Array.isArray(property.oneOf)) return titled(property.oneOf);
    if (Array.isArray(property.enum)) return untitled(property.enum);
    return undefined;
  }
  if (property.type !== "array") return undefined;
  const items = record(property.items);
  if (Array.isArray(items?.anyOf)) return titled(items.anyOf);
  if (Array.isArray(items?.enum)) return untitled(items.enum);
  return undefined;
}

/** Elicitation field types Dext renders as a free-text input. */
const SCALAR_TYPES = new Set(["boolean", "number", "integer"]);
const BOOLEAN_OPTIONS = [{ label: "Yes", description: "" }, { label: "No", description: "" }];

/** The form's field map, or undefined when the schema declares no renderable form. */
function formFields(requestedSchema: unknown): [string, Record<string, unknown>][] | undefined {
  const properties = record(requestedSchema)?.properties;
  if (!record(properties)) return undefined;
  return Object.entries(properties as Record<string, unknown>).flatMap(([id, value]) => {
    const property = record(value);
    return property ? [[id, property] as [string, Record<string, unknown>]] : [];
  });
}

/** Map an elicitation form schema onto Dext's shared question shape. Returns
 * undefined for any schema Dext cannot round-trip, so the agent is told plainly
 * instead of being handed an answer the schema never allowed. */
export function elicitationFormQuestions(requestedSchema: unknown): AgentInputQuestion[] | undefined {
  const fields = formFields(requestedSchema);
  if (!fields?.length || fields.length > MAX_FIELDS) return undefined;
  const questions: AgentInputQuestion[] = [];
  for (const [id, property] of fields) {
    const choices = propertyChoices(property);
    if (choices !== undefined && !choices.length) return undefined;
    if (choices === undefined && !SCALAR_TYPES.has(text(property.type)) && property.type !== "string") return undefined;
    const detail = text(property.description);
    questions.push({ id, header: "", question: text(property.title) || id,
      options: choices?.map(({ label, description }) => ({ label, description })) ?? (property.type === "boolean" ? BOOLEAN_OPTIONS : []),
      ...(detail ? { detail } : {}) });
  }
  return questions;
}

/** Cards report the label the user read, so an enum answer maps back to the
 * value its label stands for; free text passes through as the value itself. */
function elicitationValue(property: Record<string, unknown>, values: string[]): string | number | boolean | string[] | undefined {
  const choices = propertyChoices(property);
  const encode = (label: string): string => choices?.find((choice) => choice.label === label)?.value ?? label;
  if (property.type === "array") return values.map(encode);
  const value = values[0]!;
  if (property.type === "boolean") return value === BOOLEAN_OPTIONS[0]!.label ? true : value === BOOLEAN_OPTIONS[1]!.label ? false : undefined;
  if (property.type === "number" || property.type === "integer") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return encode(value);
}

/** Encode a Dext answer batch as an elicitation response. */
export function elicitationFormResponse(requestedSchema: unknown, answers: AgentInputAnswers | null): ElicitationFormResult {
  const fields = formFields(requestedSchema);
  if (!fields) return { action: "decline" };
  if (!answers) return { action: "cancel" };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [id, property] of fields) {
    const values = answers[id]?.answers.map((value) => value.trim()).filter(Boolean) ?? [];
    const value = values.length ? elicitationValue(property, values) : undefined;
    if (value === undefined) return { action: "decline" };
    content[id] = value;
  }
  return { action: "accept", content };
}
