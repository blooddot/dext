import type { InputExecutionResponse } from "../contracts/types.js";

export class DextRunError extends Error {
  constructor(message: string, readonly response: InputExecutionResponse) {
    super(message);
    this.name = "DextRunError";
  }
}

export class ExecutionCancelledError extends Error {
  constructor(message = "Execution was cancelled.", readonly response?: InputExecutionResponse) {
    super(message);
    this.name = "ExecutionCancelledError";
  }
}
