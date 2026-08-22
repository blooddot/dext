import type { DextRuntime } from "./runtime.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import type {
  DextResult,
  CodeRef,
  InputExecutionResponse,
  InvocationValue,
  WorkflowCondition,
  ExecutionMetadata,
  WorkflowExpression,
  WorkflowProgram,
  WorkflowStatement,
  WorkflowStepResponse
} from "./types.js";

type RuntimeValue = InvocationValue | DextResult;

/** How many comprehension branches run at once. Each branch can start a CLI
 * process, so the default stays low enough that a fan-out over a large list does
 * not exhaust the machine. */
export const DEFAULT_MAX_CONCURRENCY = 4;

export class WorkflowRuntime {
  private maxConcurrency = DEFAULT_MAX_CONCURRENCY;

  constructor(private readonly runtime: DextRuntime) {}

  setMaxConcurrency(value: number): void {
    this.maxConcurrency = Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MAX_CONCURRENCY;
  }

  async execute(
    program: WorkflowProgram,
    supplementalContext: readonly CodeRef[] = [],
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<InputExecutionResponse> {
    const environment = new Map<string, RuntimeValue>();
    const steps: WorkflowStepResponse[] = [];
    await this.executeStatements(program.statements, environment, steps, metadata, supplementalContext);
    return {
      kind: "workflow",
      executions: steps.flatMap((step) => step.response ? [step.response] : []),
      steps
    };
  }

  async executeValue(
    program: WorkflowProgram,
    initial: readonly (readonly [string, RuntimeValue])[] = [],
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<DextResult> {
    const environment = new Map<string, RuntimeValue>(initial);
    const steps: WorkflowStepResponse[] = [];
    const completed = await this.executeStatements(program.statements, environment, steps, metadata);
    const cancelled = [...steps].reverse().find((step) => step.state === "cancelled");
    if (!completed && cancelled) throw new ExecutionCancelledError(cancelled.error);
    if (!completed || !program.returnExpression) {
      throw new Error("Custom API main() did not return a result.");
    }
    const value = await this.evaluateAsync(program.returnExpression, environment, metadata);
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("kind" in value)) {
      throw new Error("Custom API main() must return a Dext result.");
    }
    return value as DextResult;
  }

  private async executeStatements(
    statements: readonly WorkflowStatement[],
    environment: Map<string, RuntimeValue>,
    steps: WorkflowStepResponse[],
    metadata: Readonly<ExecutionMetadata> = {},
    supplementalContext: readonly CodeRef[] = []
  ): Promise<boolean> {
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]!;
      if (statement.kind === "if") {
        const condition = this.evaluateCondition(statement.condition, environment);
        const selected = condition ? statement.consequent : statement.alternate;
        const skipped = condition ? statement.alternate : statement.consequent;
        this.markSkipped(skipped, steps);
        if (!await this.executeStatements(selected, environment, steps, metadata, supplementalContext)) {
          this.markSkipped(statements.slice(index + 1), steps);
          return false;
        }
        continue;
      }
      if (statement.kind === "for") {
        if (!await this.executeLoop(statement, environment, steps, metadata, supplementalContext)) {
          this.markSkipped(statements.slice(index + 1), steps);
          return false;
        }
        continue;
      }
      if (statement.kind === "try") {
        if (!await this.executeTry(statement, environment, steps, metadata, supplementalContext)) {
          this.markSkipped(statements.slice(index + 1), steps);
          return false;
        }
        continue;
      }
      if (statement.kind === "assign" && statement.expression.kind === "comprehension") {
        if (!await this.executeFanOut(statement.assignment, statement.expression, environment, steps, metadata)) {
          this.markSkipped(statements.slice(index + 1), steps);
          return false;
        }
        continue;
      }
      if (statement.kind === "assign") {
        const step: WorkflowStepResponse = {
          assignment: statement.assignment,
          method: "=",
          state: "success"
        };
        try {
          if (metadata.signal?.aborted) throw new ExecutionCancelledError();
          environment.set(statement.assignment, await this.evaluateAsync(statement.expression, environment, metadata));
        } catch (error) {
          step.state = error instanceof ExecutionCancelledError ? "cancelled" : "failed";
          step.error = error instanceof Error ? error.message : String(error);
          steps.push(step);
          this.markSkipped(statements.slice(index + 1), steps);
          return false;
        }
        steps.push(step);
        continue;
      }
      const step: WorkflowStepResponse = {
        ...(statement.assignment ? { assignment: statement.assignment } : {}),
        method: statement.call.method,
        state: "success"
      };
      try {
        if (metadata.signal?.aborted) throw new ExecutionCancelledError();
        const response = await this.runtime.execute({
          kind: "invocation",
          method: statement.call.method,
          source: "code",
          arguments: await Promise.all(statement.call.arguments.map(async (argument) => ({
            name: argument.name,
            value: await this.evaluateAsync(argument.value, environment, metadata) as InvocationValue
          })))
        }, supplementalContext, metadata);
        step.response = response;
        if (statement.assignment) environment.set(statement.assignment, response.result);
      } catch (error) {
        step.state = error instanceof ExecutionCancelledError ? "cancelled" : "failed";
        step.error = error instanceof Error ? error.message : String(error);
        steps.push(step);
        this.markSkipped(statements.slice(index + 1), steps);
        return false;
      }
      steps.push(step);
    }
    return true;
  }

  /** A failure inside the body hands control to the handler instead of skipping
   * the rest of the workflow. Cancellation is not a failure the workflow gets to
   * recover from: stopping is the user's decision, so it passes straight through
   * and the handler never runs. The finalizer runs on every path. */
  private async executeTry(
    statement: Extract<WorkflowStatement, { kind: "try" }>,
    environment: Map<string, RuntimeValue>,
    steps: WorkflowStepResponse[],
    metadata: Readonly<ExecutionMetadata>,
    supplementalContext: readonly CodeRef[]
  ): Promise<boolean> {
    const start = steps.length;
    const succeeded = await this.executeStatements(statement.body, environment, steps, metadata, supplementalContext);
    const recorded = steps.slice(start);
    if (recorded.some((step) => step.state === "cancelled")) {
      // Nothing left to clean up with: every step in the finalizer would abort
      // immediately, so saying it was skipped is the honest report.
      this.markSkipped(statement.handler, steps);
      this.markSkipped(statement.finalizer, steps);
      return false;
    }
    if (succeeded) {
      this.markSkipped(statement.handler, steps);
      return this.runFinalizer(statement, environment, steps, metadata, supplementalContext);
    }
    const failure = [...recorded].reverse().find((step) => step.state === "failed");
    const had = statement.error !== undefined && environment.has(statement.error);
    const previous = statement.error === undefined ? undefined : environment.get(statement.error);
    if (statement.error !== undefined) {
      environment.set(statement.error, failure?.error ?? "The step failed without a message.");
    }
    let handled: boolean;
    try {
      handled = await this.executeStatements(statement.handler, environment, steps, metadata, supplementalContext);
    } finally {
      if (statement.error !== undefined) {
        if (had) environment.set(statement.error, previous as RuntimeValue);
        else environment.delete(statement.error);
      }
    }
    const finalized = await this.runFinalizer(statement, environment, steps, metadata, supplementalContext);
    return handled && finalized;
  }

  private async runFinalizer(
    statement: Extract<WorkflowStatement, { kind: "try" }>,
    environment: Map<string, RuntimeValue>,
    steps: WorkflowStepResponse[],
    metadata: Readonly<ExecutionMetadata>,
    supplementalContext: readonly CodeRef[]
  ): Promise<boolean> {
    if (!statement.finalizer.length) return true;
    return this.executeStatements(statement.finalizer, environment, steps, metadata, supplementalContext);
  }

  /** The loop variable is restored afterwards so the body cannot leak it, and an
   * empty list marks the body skipped rather than silently doing nothing. */
  private async executeLoop(
    statement: Extract<WorkflowStatement, { kind: "for" }>,
    environment: Map<string, RuntimeValue>,
    steps: WorkflowStepResponse[],
    metadata: Readonly<ExecutionMetadata>,
    supplementalContext: readonly CodeRef[]
  ): Promise<boolean> {
    let items: RuntimeValue;
    try {
      if (metadata.signal?.aborted) throw new ExecutionCancelledError();
      items = await this.evaluateAsync(statement.iterable, environment, metadata);
    } catch (error) {
      steps.push({
        method: "for",
        state: error instanceof ExecutionCancelledError ? "cancelled" : "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      this.markSkipped(statement.body, steps);
      return false;
    }
    if (!Array.isArray(items)) {
      steps.push({ method: "for", state: "failed", error: `for requires a list but '${statement.variable}' was given a single value.` });
      this.markSkipped(statement.body, steps);
      return false;
    }
    if (!items.length) {
      this.markSkipped(statement.body, steps);
      return true;
    }
    const had = environment.has(statement.variable);
    const previous = environment.get(statement.variable);
    try {
      for (const item of items) {
        environment.set(statement.variable, item as RuntimeValue);
        if (!await this.executeStatements(statement.body, environment, steps, metadata, supplementalContext)) {
          return false;
        }
      }
    } finally {
      if (had) environment.set(statement.variable, previous as RuntimeValue);
      else environment.delete(statement.variable);
    }
    return true;
  }

  private evaluate(expression: WorkflowExpression, environment: Map<string, RuntimeValue>): RuntimeValue {
    if (expression.kind === "literal") return expression.value;
    if (expression.kind === "reference") return expression.reference;
    if (expression.kind === "list") return expression.values.map((value) => this.evaluate(value, environment)) as InvocationValue[];
    if (expression.kind === "object") {
      return Object.fromEntries(expression.entries.map((entry) => [entry.key, this.evaluate(entry.value, environment)]));
    }
    if (expression.kind === "variable") {
      const value = environment.get(expression.name);
      if (value === undefined) throw new Error(`Variable '${expression.name}' is unavailable.`);
      return value;
    }
    if (expression.kind === "call" || expression.kind === "comprehension") {
      throw new Error("Nested API calls must be evaluated asynchronously.");
    }
    if (expression.kind !== "member") {
      throw new Error("Unsupported Dext workflow expression.");
    }
    const object = this.evaluate(expression.object, environment);
    if (typeof object !== "object" || object === null || Array.isArray(object)) {
      throw new Error(`Cannot read '${expression.property}' from a non-object value.`);
    }
    const value = (object as unknown as Record<string, RuntimeValue>)[expression.property];
    if (value === undefined) throw new Error(`Result field '${expression.property}' is unavailable.`);
    return value;
  }

  private async evaluateAsync(
    expression: WorkflowExpression,
    environment: Map<string, RuntimeValue>,
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<RuntimeValue> {
    if (metadata.signal?.aborted) throw new ExecutionCancelledError();
    if (expression.kind === "call") {
      const response = await this.runtime.execute({
        kind: "invocation",
        method: expression.call.method,
        source: "code",
        arguments: await Promise.all(expression.call.arguments.map(async (argument) => ({
          name: argument.name,
          value: await this.evaluateAsync(argument.value, environment, metadata) as InvocationValue
        })))
      }, [], metadata);
      return response.result;
    }
    if (expression.kind === "member") {
      const object = await this.evaluateAsync(expression.object, environment, metadata);
      if (typeof object !== "object" || object === null || Array.isArray(object)) {
        throw new Error(`Cannot read '${expression.property}' from a non-object value.`);
      }
      const value = (object as unknown as Record<string, RuntimeValue>)[expression.property];
      if (value === undefined) throw new Error(`Result field '${expression.property}' is unavailable.`);
      return value;
    }
    if (expression.kind === "comprehension") return this.evaluateComprehension(expression, environment, metadata);
    if (expression.kind === "list") {
      return Promise.all(expression.values.map((value) => this.evaluateAsync(value, environment, metadata))) as Promise<InvocationValue>;
    }
    if (expression.kind === "object") {
      const entries = await Promise.all(expression.entries.map(async (entry) => [
        entry.key,
        await this.evaluateAsync(entry.value, environment, metadata)
      ] as const));
      return Object.fromEntries(entries);
    }
    return this.evaluate(expression, environment);
  }

  /** Branches run concurrently up to the configured limit. Each gets its own copy
   * of the environment so a branch cannot observe another's loop variable, and
   * results are written back by index so the list order matches the input list
   * regardless of which branch finishes first. */
  private async evaluateComprehension(
    expression: Extract<WorkflowExpression, { kind: "comprehension" }>,
    environment: Map<string, RuntimeValue>,
    metadata: Readonly<ExecutionMetadata>,
    steps?: WorkflowStepResponse[]
  ): Promise<RuntimeValue> {
    const items = await this.evaluateAsync(expression.iterable, environment, metadata);
    if (!Array.isArray(items)) {
      throw new Error(`A comprehension requires a list but '${expression.variable}' was given a single value.`);
    }
    const results = new Array<RuntimeValue>(items.length);
    // Steps are placed by index rather than appended, so Output lists the
    // branches in list order even though they finish out of order.
    const branchSteps = new Array<WorkflowStepResponse | undefined>(items.length);
    const method = expression.body.kind === "call" ? expression.body.call.method : "=";
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const index = next;
        next += 1;
        // A cancelled run stops handing out work, so the branches still in flight
        // are the only ones left to settle.
        if (metadata.signal?.aborted) throw new ExecutionCancelledError();
        const scope = new Map(environment);
        scope.set(expression.variable, items[index] as RuntimeValue);
        if (!steps) {
          results[index] = await this.evaluateAsync(expression.body, scope, metadata);
          continue;
        }
        const step: WorkflowStepResponse = { method, state: "success", branch: index };
        branchSteps[index] = step;
        try {
          if (expression.body.kind === "call") {
            const response = await this.runtime.execute({
              kind: "invocation",
              method: expression.body.call.method,
              source: "code",
              arguments: await Promise.all(expression.body.call.arguments.map(async (argument) => ({
                name: argument.name,
                value: await this.evaluateAsync(argument.value, scope, metadata) as InvocationValue
              })))
            }, [], metadata);
            step.response = response;
            results[index] = response.result;
          } else {
            results[index] = await this.evaluateAsync(expression.body, scope, metadata);
          }
        } catch (error) {
          step.state = error instanceof ExecutionCancelledError ? "cancelled" : "failed";
          step.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      }
    };
    const width = Math.min(this.maxConcurrency, items.length);
    try {
      await Promise.all(Array.from({ length: width }, () => worker()));
    } finally {
      if (steps) steps.push(...branchSteps.filter((step): step is WorkflowStepResponse => step !== undefined));
    }
    return results as InvocationValue;
  }

  /** A comprehension assignment is run here rather than through the plain assign
   * path so each branch shows up as its own step in Output. */
  private async executeFanOut(
    assignment: string,
    expression: Extract<WorkflowExpression, { kind: "comprehension" }>,
    environment: Map<string, RuntimeValue>,
    steps: WorkflowStepResponse[],
    metadata: Readonly<ExecutionMetadata>
  ): Promise<boolean> {
    try {
      if (metadata.signal?.aborted) throw new ExecutionCancelledError();
      const value = await this.evaluateComprehension(expression, environment, metadata, steps);
      environment.set(assignment, value);
    } catch (error) {
      // A branch that recorded its own failure already explains itself; anything
      // else failed before the fan-out started and needs a step of its own.
      if (!steps.some((step) => step.branch !== undefined && step.state !== "success")) {
        steps.push({
          assignment,
          method: "=",
          state: error instanceof ExecutionCancelledError ? "cancelled" : "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return false;
    }
    steps.push({ assignment, method: "=", state: "success" });
    return true;
  }

  private evaluateCondition(condition: WorkflowCondition, environment: Map<string, RuntimeValue>): boolean {
    if (condition.kind === "boolean") return this.evaluate(condition.value, environment) === true;
    const left = this.evaluate(condition.left, environment);
    const right = this.evaluate(condition.right, environment);
    return condition.operator === "==" ? left === right : left !== right;
  }

  private markSkipped(statements: readonly WorkflowStatement[], steps: WorkflowStepResponse[]): void {
    for (const statement of statements) {
      if (statement.kind === "step") {
        steps.push({
          ...(statement.assignment ? { assignment: statement.assignment } : {}),
          method: statement.call.method,
          state: "skipped"
        });
      } else if (statement.kind === "assign") {
        steps.push({ assignment: statement.assignment, method: "=", state: "skipped" });
      } else if (statement.kind === "for") {
        this.markSkipped(statement.body, steps);
      } else if (statement.kind === "try") {
        this.markSkipped(statement.body, steps);
        this.markSkipped(statement.handler, steps);
        this.markSkipped(statement.finalizer, steps);
      } else {
        this.markSkipped(statement.consequent, steps);
        this.markSkipped(statement.alternate, steps);
      }
    }
  }
}
