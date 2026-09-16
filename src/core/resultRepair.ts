import { AxGenerateError, ax, type AxAIService } from "@ax-llm/ax";
import { performance } from "node:perf_hooks";
import { REPAIR_OUTPUT_FIELD, repairSignature, type AxMethodContract } from "./axAdapter.js";
import { evaluate, type AgentAssertionSnapshot } from "./agentAssertions.js";
import { CliAxAIService, type CliAxTransport } from "./cliAxAIService.js";
import type { AgentTokenUsage, DextResult } from "./types.js";

/** Call accounting surfaced through the existing agent status event. */
export interface ResultRepairEvent {
  /** Number of one-shot CLI calls the predictor made (`1 + maxRetries` at most). */
  calls: number;
  durationMs: number;
  /** Sum of every CLI call's provider-reported token usage. */
  usage?: AgentTokenUsage;
  /** CLI subscriptions have no per-token price; kept explicit for the UI. */
  estimatedCost: number;
}

/** `undefined` result plus diagnostics is the failure shape: ax error types stay
 * inside this module and never leak to the runtime. */
export interface ResultRepairOutcome {
  result?: DextResult;
  diagnostics?: string;
}

export interface ResultRepairOptions {
  /** Prebuilt service (tests, or an application that already bound a CLI). When
   * absent, `transport` builds a per-call `CliAxAIService`. */
  service?: AxAIService;
  contract: AxMethodContract;
  outputField?: string;
  transport?: CliAxTransport;
}

export interface ResultRepairRequest {
  raw: string;
  diagnostics: string;
  /** Per-call contract; falls back to the factory contract. */
  contract?: AxMethodContract;
  signal?: AbortSignal;
  snapshot: AgentAssertionSnapshot;
  /** Mirrors `agent(patch=…)`: false means the result must not carry a patch. */
  includePatch: boolean;
  /** Per-call transport override. The application binds the current profile's
   * one-shot read-only CLI here (a static predictor cannot know the profile). */
  transport?: CliAxTransport;
  model?: string;
  onEvent?: (event: ResultRepairEvent) => void;
}

/**
 * `agent(patch=false)` is a documented contract, so a repaired result never keeps a
 * patch the caller did not ask for even though the output schema allows one.
 */
function enforcePatchContract(result: DextResult, includePatch: boolean): DextResult {
  if (includePatch) return result;
  const record = result as unknown as Record<string, unknown>;
  if (!("patch" in record)) return result;
  const rest = { ...record };
  delete rest["patch"];
  return rest as unknown as DextResult;
}

function aggregateUsage(usages: readonly AgentTokenUsage[]): AgentTokenUsage | undefined {
  if (!usages.length) return undefined;
  const total: AgentTokenUsage = {};
  for (const usage of usages) {
    if (usage.inputTokens !== undefined) total.inputTokens = (total.inputTokens ?? 0) + usage.inputTokens;
    if (usage.cachedInputTokens !== undefined) total.cachedInputTokens = (total.cachedInputTokens ?? 0) + usage.cachedInputTokens;
    if (usage.outputTokens !== undefined) total.outputTokens = (total.outputTokens ?? 0) + usage.outputTokens;
    if (usage.totalTokens !== undefined) total.totalTokens = (total.totalTokens ?? 0) + usage.totalTokens;
  }
  return total;
}

/**
 * One bounded repair attempt: ax validates the structured output, its native
 * fixing loop appends the diagnostics to the next prompt, and at most one retry
 * (`maxRetries: 1`) is spent. The program is rebuilt on every call because the
 * assertions close over this call's workspace snapshot.
 */
export class ResultRepair {
  constructor(private readonly options: ResultRepairOptions) {}

  async repair(request: ResultRepairRequest): Promise<ResultRepairOutcome> {
    const contract = request.contract ?? this.options.contract;
    const outputField = this.options.outputField ?? REPAIR_OUTPUT_FIELD;
    const usages: AgentTokenUsage[] = [];
    let calls = 0;
    let service = this.options.service;
    if (!service) {
      const transport = request.transport ?? this.options.transport;
      if (!transport) {
        return { diagnostics: "Result repair is not configured: no CLI transport was provided." };
      }
      const recorded: CliAxTransport = async (prompt, signal) => {
        calls += 1;
        const response = await transport(prompt, signal);
        if (response.usage) usages.push(response.usage);
        return response;
      };
      service = new CliAxAIService({
        id: "dext-result-repair",
        label: "Dext result repair",
        outputField,
        transport: recorded,
        ...(request.model ? { model: request.model } : {})
      });
    }
    const program = ax(repairSignature(contract.outputSchema));
    program.addAssert(async (values: Record<string, unknown>) => {
      const { hard, soft } = await evaluate(values[outputField], request.snapshot);
      // A hard failure throws: ax aborts immediately with zero retries.
      if (hard.length) throw new Error(hard.join("\n"));
      // A soft suggestion is returned as fixing instructions for one retry.
      return soft.length ? soft.join("\n") : true;
    });
    const started = performance.now();
    // The patch contract is stated to the model and enforced afterwards, because a
    // schema-valid AgentResult may legally carry a patch the caller did not ask for.
    const instruction = request.includePatch === false
      ? "\nDo not include a patch: report the conclusion in text only."
      : "";
    try {
      const output = await program.forward(
        service,
        { agentOutput: request.raw, diagnostics: `${request.diagnostics || "No additional diagnostics."}${instruction}` },
        {
          // ax defaults maxRetries to 3; Dext's budget is one repair attempt.
          maxRetries: 1,
          ...(request.signal ? { abortSignal: request.signal } : {})
        }
      );
      const result = (output as Record<string, unknown>)[outputField];
      this.report(request, usages, calls, started);
      if (result === undefined) return { diagnostics: "Repair produced no structured output." };
      return { result: enforcePatchContract(result as DextResult, request.includePatch) };
    } catch (error) {
      this.report(request, usages, calls, started);
      // A cancelled outer run must stay cancelled; every other ax failure
      // (AxGenerateError for validation/assertion exhaustion, and ax's plain
      // parse errors) becomes a diagnostic for the runtime's final report.
      if (request.signal?.aborted) throw error;
      if (error instanceof AxGenerateError) return { diagnostics: error.message };
      return { diagnostics: error instanceof Error ? error.message : String(error) };
    }
  }

  private report(
    request: ResultRepairRequest,
    usages: readonly AgentTokenUsage[],
    calls: number,
    started: number
  ): void {
    if (!request.onEvent) return;
    const usage = aggregateUsage(usages);
    request.onEvent({
      calls,
      durationMs: performance.now() - started,
      estimatedCost: 0,
      ...(usage ? { usage } : {})
    });
  }
}

export function createResultRepair(options: ResultRepairOptions): ResultRepair {
  return new ResultRepair(options);
}
