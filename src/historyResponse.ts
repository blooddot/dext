import type { InputExecutionResponse, RuntimeResponse } from "./core/types.js";
import type { DextHistoryRecord } from "./historyStore.js";

/** Compatibility belongs at the persisted-data boundary, not in API contracts. */
export function normalizeHistoryResponse(response: InputExecutionResponse, mode?: DextHistoryRecord["mode"]): InputExecutionResponse {
  const normalize = (execution: RuntimeResponse): RuntimeResponse => {
    const result = execution.result as unknown as Record<string, unknown>;
    if (result.kind !== "chat" || typeof result.text !== "string") return execution;
    const method = execution.method.id;
    const kind = result.planPath || result.executePlan || method === "plan" ? "plan"
      : method === "agent" || method === "ask" || method === "skill" ? method
        : mode && mode !== "code" ? mode : "ask";
    return { ...execution, result: { ...result, kind, text: result.text } };
  };
  const executions = response.executions.map(normalize);
  const steps = response.steps?.map((step) => {
    if (!step.response) return step;
    const next = normalize(step.response);
    return next === step.response ? step : { ...step, response: next };
  });
  if (executions.every((execution, index) => execution === response.executions[index])
    && steps?.every((step, index) => step === response.steps?.[index]) !== false) return response;
  return { ...response, executions, ...(steps ? { steps } : {}) };
}

/** Decode lazily when a turn is opened; never rewrite or truncate saved output. */
export function readHistoryResponse(record: Pick<DextHistoryRecord, "response" | "output" | "mode">): InputExecutionResponse | undefined {
  if (record.response) return normalizeHistoryResponse(record.response, record.mode);
  try {
    const value = JSON.parse(record.output) as InputExecutionResponse | null;
    return value?.kind === "workflow" && Array.isArray(value.executions)
      ? normalizeHistoryResponse(value, record.mode) : undefined;
  } catch {
    return undefined;
  }
}
