export class ExecutionCancelledError extends Error {
  constructor(message = "Execution was cancelled.") {
    super(message);
    this.name = "ExecutionCancelledError";
  }
}
