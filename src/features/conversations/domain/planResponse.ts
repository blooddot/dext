/**
 * Plan turns have two distinct deliverables: a short response for the chat
 * and the complete Markdown document to persist.  The delimiters are HTML
 * comments so they are innocuous if an agent happens to preview the response
 * as Markdown, while remaining unambiguous to extract.
 */
export const PLAN_DOCUMENT_START = "<!-- dext-plan:start -->";
export const PLAN_DOCUMENT_END = "<!-- dext-plan:end -->";
/**
 * Some providers occasionally return a valid plan document without the
 * conversational preamble requested by the format instruction. Keep that
 * response usable (and persist the plan) instead of failing the entire turn.
 */
export const PLAN_FALLBACK_CONVERSATION = "Plan generated successfully.";

export interface PlanResponse {
  /** The user-facing explanation displayed in the conversation. */
  conversation: string;
  /** The complete plan document written to the plan file. */
  document: string;
}

/** Removes the persisted document from a streamed Plan reply before it is
 * shown in Process. The complete text is still returned to savePlan(). */
export function stripPlanDocument(response: string, hideIncomplete = false): string {
  const start = response.indexOf(PLAN_DOCUMENT_START);
  if (start < 0) return response;
  const end = response.indexOf(PLAN_DOCUMENT_END, start + PLAN_DOCUMENT_START.length);
  // A streamed delta may contain only the opening marker. Leave it intact
  // until the completed assistant snapshot arrives, otherwise later deltas
  // could be rendered without the context needed to hide the document.
  if (end < 0) return hideIncomplete ? response.slice(0, start).trimEnd() : response;
  const before = response.slice(0, start).trim();
  const after = response.slice(end + PLAN_DOCUMENT_END.length).trim();
  return [before, after].filter(Boolean).join("\n\n");
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
  // The delimiters and document are the durable part of a Plan response. If
  // a model omits the requested conversational wrapper, synthesize a concise
  // reply so saving the document does not turn into a failed/interrupted run.
  const conversation = [before, after].filter(Boolean).join("\n\n") || PLAN_FALLBACK_CONVERSATION;
  const document = response.slice(documentStart, end).trim();
  if (!document) throw new Error("Plan response contains an empty document.");
  return { conversation, document };
}
