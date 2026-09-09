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
        if (!entry || entry.answers.length !== 1 || !entry.answers[0]?.trim()) return;
        const value = entry.answers[0].trim();
        fields[question.id] = question.options.length ? question.options.some((option) => option.label === value)
          ? { type: "radio", selected: [value] } : { type: "radio", selected: [], custom: value }
          : { type: "input", value };
      }
    }
    this.broker.respond(sessionId, turnId, requestId, { kind: "ui", type: "form", status: answers ? "submitted" : "cancelled", answers: fields });
  }
  dispose(): void { this.broker.dispose(); }
}
