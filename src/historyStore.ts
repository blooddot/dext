import type * as vscode from "vscode";
import type { AgentStreamEvent, InputExecutionResponse } from "./core/types.js";

const HISTORY_KEY = "dext.history";
const MAX_RECORDS = 100;
const MAX_OUTPUT_LENGTH = 200_000;

export interface DextHistoryRecord {
  id: string;
  createdAt: number;
  input: string;
  process: AgentStreamEvent[];
  output: string;
  response?: InputExecutionResponse;
  error?: string;
}

function bounded(value: string): string {
  return value.length > MAX_OUTPUT_LENGTH
    ? `${value.slice(0, MAX_OUTPUT_LENGTH)}\n... output truncated ...`
    : value;
}

function serializeResponse(response: InputExecutionResponse): string {
  try {
    return bounded(JSON.stringify(response, null, 2));
  } catch {
    return "Unable to serialize execution output.";
  }
}

export class DextHistoryStore {
  constructor(private readonly state: vscode.Memento) {}

  list(): DextHistoryRecord[] {
    return this.state.get<DextHistoryRecord[]>(HISTORY_KEY, []);
  }

  async addSuccess(input: string, process: readonly AgentStreamEvent[], response: InputExecutionResponse): Promise<void> {
    await this.add({
      input: bounded(input),
      process: process.map((event) => ({ ...event, text: bounded(event.text) })),
      output: serializeResponse(response),
      response
    });
  }

  async addFailure(input: string, process: readonly AgentStreamEvent[], error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.add({
      input: bounded(input),
      process: process.map((event) => ({ ...event, text: bounded(event.text) })),
      output: "",
      error: bounded(message)
    });
  }

  private async add(record: Omit<DextHistoryRecord, "id" | "createdAt">): Promise<void> {
    const next: DextHistoryRecord[] = [
      ...this.list(),
      { ...record, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: Date.now() }
    ];
    await this.state.update(HISTORY_KEY, next.slice(-MAX_RECORDS));
  }
}
