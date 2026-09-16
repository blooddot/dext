import type { AgentInputAnswers, AgentInputRequest } from "./core/types.js";
import { UiInteractionBroker } from "./uiInteractionBroker.js";
import { agentInputForm, agentFormAnswers } from "./uiInteractionPresentation.js";
import type { UiFormAnswers } from "./core/uiForm.js";

export class AgentInputBroker {
  private readonly broker = new UiInteractionBroker();
  private readonly requests = new Map<string, AgentInputRequest>();
  async request(sessionId: string, turnId: string, request: AgentInputRequest, signal: AbortSignal): Promise<AgentInputAnswers | null> {
    const key = JSON.stringify([sessionId, turnId, request.id]);
    if (this.requests.has(key)) return null;
    this.requests.set(key, request);
    try { return agentFormAnswers(await this.broker.request(sessionId, turnId, agentInputForm(request), signal, undefined, request.id)); }
    catch { return null; }
    finally { this.requests.delete(key); }
  }
  respond(sessionId: string, turnId: string, requestId: string, answers: AgentInputAnswers | null): void {
    const request = this.requests.get(JSON.stringify([sessionId, turnId, requestId]));
    if (!request) return;
    const fields: UiFormAnswers = {};
    if (answers) {
      if (Object.keys(answers).length !== request.questions.length) return;
      for (const question of request.questions) {
        const entry = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
        const values = entry?.answers.map((value) => value.trim()).filter(Boolean) ?? [];
        if (!values.length || (!question.multiSelect && values.length !== 1)) return;
        if (!question.options.length) { fields[question.id] = { type: "input", value: values[0]! }; continue; }
        const labels = new Set(question.options.map((option) => option.label));
        const selected = values.filter((value) => labels.has(value));
        const custom = values.filter((value) => !labels.has(value));
        if (custom.length > 1) return;
        // A multi-select question reports every chosen label; single-select keeps
        // the original radio shape, where a custom answer excludes the options.
        fields[question.id] = question.multiSelect ? { type: "checkbox", selected, ...(custom.length ? { custom: custom[0]! } : {}) }
          : selected.length ? { type: "radio", selected } : { type: "radio", selected: [], custom: custom[0]! };
      }
    }
    this.broker.respond(sessionId, turnId, requestId, { kind: "ui", type: "form", status: answers ? "submitted" : "cancelled", answers: fields });
  }
  dispose(): void { this.broker.dispose(); }
}
