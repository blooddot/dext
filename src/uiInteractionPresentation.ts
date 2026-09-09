import type { AgentInputAnswers, AgentInputRequest } from "./core/types.js";
import type { UiFormDefinition, UiFormResult, UiInteractionState } from "./core/uiForm.js";

export function agentInputForm(request: AgentInputRequest): UiFormDefinition {
  return { title: "Question", description: request.blocking ? "Waiting for your answer" : "You can answer while the agent works",
    presentation: "inline", submit_label: "Submit answer", cancel_label: "Skip", show_cancel: true,
    fields: request.questions.map((question) => question.options.length
      ? { id: question.id, type: "radio", label: question.question, required: true, allow_custom: true,
        secret: question.isSecret === true, custom_placeholder: "Or type your own answer…",
        options: question.options.map((option) => ({ value: option.label, label: option.label, description: option.description })) }
      : { id: question.id, type: "input", label: question.question, required: true, secret: question.isSecret === true, placeholder: "Type your answer…" }) };
}
export function agentFormAnswers(result: UiFormResult): AgentInputAnswers | null {
  if (result.status === "cancelled") return null;
  return Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, { answers: [
    answer.type === "input" ? answer.value.trim() : (("custom" in answer ? answer.custom : undefined) || answer.selected[0] || "").trim()
  ] }]));
}
export function publicInteractionState(state: UiInteractionState): UiInteractionState {
  const answers = { ...state.answers };
  for (const field of state.form.fields) if (field.secret) delete answers[field.id];
  return { ...state, ...(state.answers ? { answers } : {}) };
}

/** Used by both live output and history, including results unknown to this version. */
export function uiResultText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).slice(0, 20000);
  if (typeof value !== "object") return "Unavailable result";
  const result = value as Record<string, unknown>;
  if (["select", "radio", "checkbox"].includes(String(result.type)) && Array.isArray(result.selected)) {
    return [...result.selected.filter((item) => typeof item === "string"), ...(typeof result.custom === "string" ? [result.custom] : [])].join(", ").slice(0, 20000) || "No selection";
  }
  if (result.type === "confirm" && typeof result.confirmed === "boolean") return result.confirmed ? "Confirmed" : "Cancelled";
  if (result.type === "input") return typeof result.value === "string" ? result.value.slice(0, 20000) : "No input";
  if (result.type === "alert") return result.status === "acknowledged" ? "Acknowledged" : "Dismissed";
  if (result.type === "form" && result.answers && typeof result.answers === "object") {
    return [String(result.status), ...Object.entries(result.answers).map(([id, answer]) => `${id}: ${uiResultText(answer)}`)].join("\n").slice(0, 20000);
  }
  try { return (JSON.stringify(value, null, 2) ?? "").slice(0, 20000); } catch { return "Unavailable result"; }
}
