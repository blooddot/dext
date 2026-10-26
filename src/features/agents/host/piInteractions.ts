import type { AgentConversationRequest } from "./agentRunner.js";
import type { AgentInputAnswers, AgentInputQuestion } from "../../../shared/contracts/types.js";
import type { AgentTimeout } from "../domain/agentTimeout.js";
import { piObject, piText, type PiUiRequest } from "../contracts/pi.js";
import { uiCallForm } from "../../../shared/contracts/uiForm.js";

export async function piQuestion(request: AgentConversationRequest, id: string, questions: AgentInputQuestion[], signal: AbortSignal, timeout: AgentTimeout): Promise<unknown> {
  const respond = request.metadata.requestAgentInput, emit = request.onEvent;
  if (!respond || !emit || signal.aborted) return { status: "unavailable" };
  const input = { id, questions, blocking: true };
  const publish = (status: "waiting" | "answered" | "dismissed", answers?: AgentInputAnswers): void => {
    const visible = answers ? Object.fromEntries(questions.filter((question) => !question.isSecret && answers[question.id]).map((question) => [question.id, answers[question.id]!])) : undefined;
    emit({ phase: "input", text: "", userInput: { ...input, status, ...(visible ? { answers: visible } : {}) } });
  };
  timeout.toolStarted(`question:${id}`);
  try {
    const reply = respond(input, signal); publish("waiting");
    const answers = await reply;
    if (signal.aborted || !answers) { publish("dismissed"); return { status: "cancelled" }; }
    publish("answered", answers); return { status: "answered", answers };
  } catch { publish("dismissed"); return { status: "cancelled" }; }
  finally { timeout.toolFinished(`question:${id}`); }
}

export async function piUi(request: AgentConversationRequest, frame: PiUiRequest, signal: AbortSignal, timeout: AgentTimeout): Promise<object | undefined> {
  const cancelled = { type: "extension_ui_response", id: frame.id, cancelled: true };
  if (!["select", "confirm", "input", "editor"].includes(frame.method)) {
    if (["notify", "setStatus", "setWidget"].includes(frame.method)) request.onEvent?.({ phase: "status", text: "", title: piText(frame.message, piText(frame.statusText, "Pi notification")) });
    return undefined;
  }
  if (!request.metadata.ui || signal.aborted) return cancelled;
  const controller = new AbortController();
  const abort = (): void => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  const timer = typeof frame.timeout === "number" && frame.timeout > 0 ? setTimeout(abort, Math.min(frame.timeout, 2147483647)) : undefined;
  timeout.toolStarted(`ui:${frame.id}`);
  try {
    const title = piText(frame.title, "Pi");
    const form = frame.method === "confirm" ? uiCallForm("confirm", { message: `${title}\n${piText(frame.message)}`, confirm_label: "Yes", cancel_label: "No" })
      : frame.method === "select" ? uiCallForm("select", { label: title, options: frame.options })
        : uiCallForm("input", { label: title, multiline: frame.method === "editor", placeholder: piText(frame.placeholder) });
    if (frame.method === "editor" && typeof frame.prefill === "string" && form.fields[0]?.type === "input") form.fields[0].default = frame.prefill;
    const result = await request.metadata.ui.form(form, controller.signal);
    if (controller.signal.aborted || signal.aborted || result.status !== "submitted") return cancelled;
    if (frame.method === "confirm") return { type: "extension_ui_response", id: frame.id, confirmed: true };
    const answer = piObject(result.answers.answer);
    const selected = Array.isArray(answer.selected) ? (answer.selected as unknown[]).filter((value): value is string => typeof value === "string") : [];
    return { type: "extension_ui_response", id: frame.id, value: frame.method === "select" ? selected[0] : answer.value };
  } catch { return cancelled; }
  finally { if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort); timeout.toolFinished(`ui:${frame.id}`); }
}
