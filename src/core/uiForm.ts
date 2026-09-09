import { z } from "zod";
import type { UiResult } from "./types.js";

export const UI_LIMITS = { fields: 32, options: 200, text: 20000, label: 2000, bytes: 200000 } as const;
export type UiPresentation = "inline" | "dialog";
export interface UiOption { value: string; label: string; description?: string | undefined }
interface UiFieldBase { id: string; label: string; description?: string | undefined; required: boolean }
export interface UiSelectionField extends UiFieldBase {
  type: "select" | "radio" | "checkbox";
  options: UiOption[];
  default?: string[] | undefined;
  multiple?: boolean | undefined;
  allow_custom?: boolean | undefined;
  custom_placeholder?: string | undefined;
  placeholder?: string | undefined;
  /** Internal Agent adapter only. Never accepted by the public field schema. */
  secret?: boolean | undefined;
}
export interface UiInputField extends UiFieldBase {
  type: "input"; default?: string | undefined; placeholder?: string | undefined; multiline?: boolean | undefined;
  secret?: boolean | undefined;
  /** The standalone input API accepts and preserves empty strings. */
  preserveEmpty?: boolean | undefined;
}
export type UiField = UiSelectionField | UiInputField;
export interface UiFormDefinition {
  title: string; fields: UiField[]; description: string; submit_label: string;
  cancel_label: string; show_cancel: boolean; presentation: UiPresentation;
}
export type UiFieldAnswer =
  | { type: "select"; selected: string[] }
  | { type: "radio" | "checkbox"; selected: string[]; custom?: string | undefined }
  | { type: "input"; value: string };
export type UiFormAnswers = Record<string, UiFieldAnswer>;
export interface UiFormResult { kind: "ui"; type: "form"; status: "submitted" | "cancelled"; answers: UiFormAnswers }
export interface UiInteractionState {
  sessionId: string; turnId: string; requestId: string; form: UiFormDefinition;
  status: "waiting" | "submitted" | "cancelled" | "closed";
  answers?: UiFormAnswers;
}

const label = z.string().min(1).max(UI_LIMITS.label);
const text = z.string().max(UI_LIMITS.text);
const selected = z.array(z.string().max(UI_LIMITS.label)).max(UI_LIMITS.options);
const optionSchema = z.union([label, z.object({ value: label, label, description: text.optional() }).strict()]);
const base = { id: z.string().min(1).max(128), label, description: text.optional(), required: z.boolean().default(true) };
const options = z.array(optionSchema).min(1).max(UI_LIMITS.options);
const selection = { ...base, options, default: selected.optional() };
const custom = { allow_custom: z.boolean().default(false), custom_placeholder: text.optional() };
export const uiFieldSchema = z.discriminatedUnion("type", [
  z.object({ ...selection, type: z.literal("select"), multiple: z.boolean().default(false), placeholder: text.optional() }).strict(),
  z.object({ ...selection, ...custom, type: z.literal("radio") }).strict(),
  z.object({ ...selection, ...custom, type: z.literal("checkbox") }).strict(),
  z.object({ ...base, type: z.literal("input"), default: text.optional(), placeholder: text.optional(), multiline: z.boolean().default(false) }).strict()
]);
export const uiFormDefinitionSchema = z.object({
  title: label, fields: z.array(uiFieldSchema).max(UI_LIMITS.fields), description: text.default(""),
  submit_label: label.default("Submit"), cancel_label: label.default("Cancel"),
  show_cancel: z.boolean().default(true), presentation: z.enum(["inline", "dialog"]).default("inline")
}).strict();
export const uiFieldAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("select"), selected }).strict(),
  z.object({ type: z.literal("radio"), selected: selected.max(1), custom: text.optional() }).strict(),
  z.object({ type: z.literal("checkbox"), selected, custom: text.optional() }).strict(),
  z.object({ type: z.literal("input"), value: text }).strict()
]);
export const uiFormAnswersSchema = z.record(z.string().max(128), uiFieldAnswerSchema).refine(
  (answers) => Object.keys(answers).length <= UI_LIMITS.fields, "Too many field answers"
);
export const uiFormResultSchema = z.object({
  kind: z.literal("ui"), type: z.literal("form"), status: z.enum(["submitted", "cancelled"]), answers: uiFormAnswersSchema
}).strict().refine((result) => result.status !== "cancelled" || Object.keys(result.answers).length === 0, "Cancelled forms must have no answers");

function checkSize(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > UI_LIMITS.bytes) throw new Error("UI interaction exceeds the size limit.");
}
export function parseUiForm(value: unknown): UiFormDefinition {
  checkSize(value);
  const parsed = uiFormDefinitionSchema.parse(value);
  const ids = new Set<string>();
  const fields: UiField[] = parsed.fields.map((field) => {
    if (ids.has(field.id) || ["__proto__", "constructor", "prototype"].includes(field.id)) throw new Error(`Invalid or duplicate field id: ${field.id}`);
    ids.add(field.id);
    if (field.type === "input") {
      if (field.required && field.default !== undefined && !field.default.trim()) throw new Error(`Invalid empty default in ${field.id}`);
      return field;
    }
    const normalized = { ...field, options: field.options.map((option) => typeof option === "string" ? { value: option, label: option } : option) };
    const values = new Set(normalized.options.map((option) => option.value));
    if (values.size !== normalized.options.length) throw new Error(`Duplicate option value in ${field.id}`);
    const defaults = normalized.default ?? [];
    if (new Set(defaults).size !== defaults.length || defaults.some((item) => !values.has(item))) throw new Error(`Invalid default in ${field.id}`);
    if (!isMultiField(normalized) && defaults.length > 1) throw new Error(`Only one default is allowed in ${field.id}`);
    if (field.required && field.default !== undefined && !defaults.length) throw new Error(`Invalid empty default in ${field.id}`);
    return normalized;
  });
  return { ...parsed, fields };
}
export function isMultiField(field: UiSelectionField): boolean {
  return field.type === "checkbox" || (field.type === "select" && field.multiple === true);
}
export function validateUiAnswers(form: UiFormDefinition, value: unknown): UiFormAnswers {
  checkSize(value);
  const answers = uiFormAnswersSchema.parse(value);
  const ids = new Set(form.fields.map((field) => field.id));
  if (Object.keys(answers).some((id) => !ids.has(id))) throw new Error("Unknown form field in answer.");
  const normalized: UiFormAnswers = {};
  for (const field of form.fields) {
    const answer = Object.hasOwn(answers, field.id) ? answers[field.id] : undefined;
    if (!answer) { if (field.required) throw new Error(`${field.label}: an answer is required.`); continue; }
    if (answer.type !== field.type) throw new Error(`${field.label}: wrong answer type.`);
    if (field.type === "input" && answer.type === "input") {
      if (!answer.value.trim() && !field.preserveEmpty) {
        if (field.required) throw new Error(`${field.label}: enter a value.`);
        continue;
      }
      normalized[field.id] = answer;
      continue;
    }
    if (field.type === "input" || answer.type === "input") throw new Error("Invalid input answer.");
    const customValue = "custom" in answer && answer.custom?.trim() ? answer.custom : undefined;
    if (new Set(answer.selected).size !== answer.selected.length) throw new Error(`${field.label}: duplicate selections.`);
    if (answer.selected.some((item) => !field.options.some((option) => option.value === item))) throw new Error(`${field.label}: unknown option.`);
    if (!isMultiField(field) && answer.selected.length > 1) throw new Error(`${field.label}: select only one option.`);
    if ("custom" in answer && answer.custom !== undefined && !field.allow_custom) throw new Error(`${field.label}: custom answers are not allowed.`);
    if (field.type === "radio" && customValue && answer.selected.length) throw new Error(`${field.label}: custom answers and options are exclusive.`);
    if (!answer.selected.length && !customValue) {
      if (field.required) throw new Error(`${field.label}: select an option.`);
      continue;
    }
    normalized[field.id] = field.type === "select"
      ? { type: "select", selected: answer.selected }
      : { type: field.type, selected: answer.selected, ...(customValue ? { custom: customValue } : {}) };
  }
  return normalized;
}

export type UiAction = "select" | "radio" | "checkbox" | "input" | "confirm" | "alert" | "form";
export function uiCallForm(action: UiAction, args: Record<string, unknown>): UiFormDefinition {
  if (action === "form") return parseUiForm(args);
  const { presentation = "dialog" } = args;
  const fields: Record<string, unknown>[] = [];
  if (action === "select" || action === "radio" || action === "checkbox") {
    const rawOptions = z.array(label).min(1).max(UI_LIMITS.options).parse(args.options);
    fields.push({ id: "answer", type: action, label: args.label, options: rawOptions,
      required: action !== "checkbox",
      ...(action === "select" ? { multiple: args.multiple ?? false, placeholder: args.placeholder ?? "Select…" }
        : { allow_custom: args.allow_custom ?? false, custom_placeholder: args.custom_placeholder ?? "" }),
      ...(action === "radio" ? { default: [rawOptions[0]] } : {}) });
  } else if (action === "input") {
    fields.push({ id: "answer", type: "input", label: args.label, required: false,
      placeholder: args.placeholder ?? "", multiline: args.multiline ?? false });
  }
  const form = parseUiForm({ title: args.label ?? (action === "alert" ? "Notice" : "Confirm"), fields,
    description: args.message ?? "", presentation,
    submit_label: action === "confirm" ? args.confirm_label ?? "Continue" : action === "alert" ? args.acknowledge_label ?? "OK" : "Submit",
    cancel_label: args.cancel_label ?? "Cancel", show_cancel: action !== "alert" });
  if (action === "input") (form.fields[0] as UiInputField).preserveEmpty = true;
  return form;
}
export function uiCallResult(action: UiAction, result: UiFormResult): UiResult {
  if (action === "form") return result;
  if (action === "confirm") return { kind: "ui", type: "confirm", confirmed: result.status === "submitted" };
  if (action === "alert") return { kind: "ui", type: "alert", status: result.status === "submitted" ? "acknowledged" : "dismissed" };
  const answer = result.answers.answer;
  if (action === "input") return { kind: "ui", type: "input", ...(result.status === "submitted" && answer?.type === "input" ? { value: answer.value } : {}) };
  const values = answer && answer.type !== "input" ? answer.selected : [];
  if (action === "select") return { kind: "ui", type: "select", selected: values };
  return { kind: "ui", type: action, selected: values,
    ...(answer && "custom" in answer && answer.custom ? { custom: answer.custom } : {}) };
}
