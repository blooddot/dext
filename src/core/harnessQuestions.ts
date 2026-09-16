import type { CreateElicitationRequest, CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { elicitationFormQuestions, elicitationFormResponse } from "./elicitationForm.js";
import type { AgentInputAnswers, AgentInputQuestion } from "./types.js";

/** One question exactly as the Harness `user-questions` seam carries it. */
export interface HarnessQuestionItem {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}
export interface HarnessQuestionAnswerItem { id: string; selected: string[]; custom?: string }
export interface HarnessQuestionAnswer { answers: HarnessQuestionAnswerItem[] }
/** One in-flight question batch travelling over Dext's private bridge channel. */
export interface HarnessQuestionRequest { id: string; questions: HarnessQuestionItem[] }
/** What Dext's UI did with a batch. `unavailable` means no Dext surface owned
 * it, so the Harness answerer delegates instead of answering the agent. */
export type HarnessQuestionOutcome =
  | { status: "answered"; answer: HarnessQuestionAnswer }
  | { status: "cancelled" }
  | { status: "unavailable" };

const MAX_QUESTIONS = 20;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Parse a bridge payload from Dext's own Harness plugin. Unknown shapes are
 * rejected instead of partially rendered, so a card always matches its request. */
export function parseHarnessQuestionRequest(value: unknown): HarnessQuestionRequest | undefined {
  const message = record(value);
  const id = text(message?.id);
  const raw = message?.questions;
  if (!message || !id || !Array.isArray(raw) || !raw.length || raw.length > MAX_QUESTIONS) return undefined;
  const questions: HarnessQuestionItem[] = [];
  for (const entry of raw) {
    const item = record(entry);
    const itemId = text(item?.id), question = text(item?.question);
    if (!item || !itemId || !question) return undefined;
    const options = item.options === undefined ? undefined : item.options;
    if (options !== undefined && !Array.isArray(options)) return undefined;
    const parsed = options?.flatMap((option) => {
      const label = text(record(option)?.label), description = text(record(option)?.description);
      return label ? [{ label, ...(description ? { description } : {}) }] : [];
    });
    if (parsed && parsed.length !== (options?.length ?? 0)) return undefined;
    questions.push({ id: itemId, question,
      ...(text(item.header) ? { header: text(item.header) } : {}),
      ...(text(item.detail) ? { detail: text(item.detail) } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      ...(parsed?.length ? { options: parsed } : {}) });
  }
  return new Set(questions.map((item) => item.id)).size === questions.length ? { id, questions } : undefined;
}

/** Project Harness questions into the shared Dext question shape. */
export function harnessInputQuestions(questions: readonly HarnessQuestionItem[]): AgentInputQuestion[] {
  return questions.map((item) => ({
    id: item.id, header: item.header ?? "", question: item.question,
    options: (item.options ?? []).map((option) => ({ label: option.label, description: option.description ?? "" })),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.multiSelect ? { multiSelect: true } : {})
  }));
}

/** Encode a Dext answer batch the way the Harness `user-questions` seam reads it:
 * selected option labels stay labels, anything else becomes the custom answer. */
export function harnessQuestionAnswer(questions: readonly AgentInputQuestion[], answers: AgentInputAnswers | null): HarnessQuestionAnswer | undefined {
  if (!answers) return undefined;
  const items: HarnessQuestionAnswerItem[] = [];
  for (const question of questions) {
    const values = answers[question.id]?.answers.map((value) => value.trim()).filter(Boolean) ?? [];
    if (!values.length) return undefined;
    const labels = new Set(question.options.map((option) => option.label));
    const selected = values.filter((value) => labels.has(value));
    const custom = values.filter((value) => !labels.has(value));
    if (custom.length > 1 || (!question.multiSelect && values.length !== 1)) return undefined;
    items.push({ id: question.id, selected: question.multiSelect ? selected : selected.slice(0, 1),
      ...(custom.length ? { custom: custom[0]! } : {}) });
  }
  return { answers: items };
}

/** Map an ACP elicitation form onto Dext's shared question shape. Returns
 * undefined for any schema Dext cannot round-trip, so the agent is told plainly
 * instead of being handed an answer the schema never allowed. */
export function elicitationQuestions(request: CreateElicitationRequest): AgentInputQuestion[] | undefined {
  if (request.mode !== "form") return undefined;
  return elicitationFormQuestions((request as { requestedSchema?: unknown }).requestedSchema);
}

/** Encode a Dext answer batch as an ACP elicitation response. */
export function elicitationResponse(request: CreateElicitationRequest, answers: AgentInputAnswers | null): CreateElicitationResponse {
  if (request.mode !== "form") return { action: "decline" };
  return elicitationFormResponse((request as { requestedSchema?: unknown }).requestedSchema, answers);
}
