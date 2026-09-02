/**
 * Plan turns have two distinct deliverables: a short response for the chat
 * and the complete Markdown document to persist.  The delimiters are HTML
 * comments so they are innocuous if an agent happens to preview the response
 * as Markdown, while remaining unambiguous to extract.
 */
export const PLAN_DOCUMENT_START = "<!-- dext-plan:start -->";
export const PLAN_DOCUMENT_END = "<!-- dext-plan:end -->";

export interface PlanResponse {
  /** The user-facing explanation displayed in the conversation. */
  conversation: string;
  /** The complete plan document written to the plan file. */
  document: string;
}

/** Separates the model's chat response from its persisted plan document. */
export function splitPlanResponse(response: string): PlanResponse {
  const start = response.indexOf(PLAN_DOCUMENT_START);
  if (start < 0) throw new Error("Plan response is missing the required document start delimiter.");
  const documentStart = start + PLAN_DOCUMENT_START.length;
  const end = response.indexOf(PLAN_DOCUMENT_END, documentStart);
  if (end < 0) throw new Error("Plan response is missing the required document end delimiter.");

  const before = response.slice(0, start).trim();
  const after = response.slice(end + PLAN_DOCUMENT_END.length).trim();
  const conversation = [before, after].filter(Boolean).join("\n\n");
  const document = response.slice(documentStart, end).trim();
  if (!conversation) throw new Error("Plan response is missing its conversational reply.");
  if (!document) throw new Error("Plan response contains an empty document.");
  return { conversation, document };
}
