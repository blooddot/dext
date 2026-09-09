import { randomBytes } from "node:crypto";
import { ExecutionCancelledError } from "./core/executionErrors.js";
import { uiFormResultSchema, validateUiAnswers, type UiFormDefinition, type UiFormResult, type UiInteractionState } from "./core/uiForm.js";

/** Only a matching live request may consume a response. Answers are validated
 * against the host's definition, never a definition supplied by the Webview. */
export class UiInteractionBroker {
  private readonly pending = new Map<string, { state: UiInteractionState; finish: (result?: UiFormResult) => void }>();
  request(sessionId: string, turnId: string, form: UiFormDefinition, signal?: AbortSignal,
    onState: (state: UiInteractionState) => void = () => {}, requestId = randomBytes(12).toString("hex")): Promise<UiFormResult> {
    if (signal?.aborted) return Promise.reject(new ExecutionCancelledError());
    const key = JSON.stringify([sessionId, turnId, requestId]);
    if (this.pending.has(key)) return Promise.reject(new Error("Duplicate interaction request."));
    const state: UiInteractionState = { sessionId, turnId, requestId, form: structuredClone(form), status: "waiting" };
    return new Promise((resolve, reject) => {
      const abort = (): void => finish();
      const finish = (result?: UiFormResult): void => {
        if (!this.pending.delete(key)) return;
        signal?.removeEventListener("abort", abort);
        try {
          onState({ ...state, status: result?.status ?? "closed", ...(result ? { answers: result.answers } : {}) });
        } catch (error) {
          reject(result ? (error instanceof Error ? error : new Error("Unable to publish interaction state.", { cause: error })) : new ExecutionCancelledError());
          return;
        }
        if (result) resolve(result); else reject(new ExecutionCancelledError());
      };
      this.pending.set(key, { state, finish });
      signal?.addEventListener("abort", abort, { once: true });
      try { onState(state); } catch (error) {
        this.pending.delete(key);
        signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error("Unable to publish interaction state.", { cause: error }));
      }
    });
  }
  respond(sessionId: string, turnId: string, requestId: string, value: unknown): boolean {
    const pending = this.pending.get(JSON.stringify([sessionId, turnId, requestId]));
    if (!pending) return false;
    try {
      const result = uiFormResultSchema.parse(value);
      if (result.status === "submitted") result.answers = validateUiAnswers(pending.state.form, result.answers);
      pending.finish(result);
      return true;
    } catch { return false; }
  }
  dispose(): void { for (const pending of [...this.pending.values()]) pending.finish(); }
}
