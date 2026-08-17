import type { DextRuntime } from "./runtime.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import type {
  DextResult,
  CodeRef,
  InterpolatedInput,
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

export class WorkflowRuntime {
  constructor(private readonly runtime: DextRuntime) {}

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
      const step: WorkflowStepResponse = {
        ...(statement.assignment ? { assignment: statement.assignment } : {}),
        method: statement.call.method,
        state: "success"
      };
      try {
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
    if (expression.kind === "call") {
      throw new Error("Nested API calls must be evaluated asynchronously.");
    }
    if (expression.kind === "format") {
      throw new Error("Dext input f-strings must be evaluated asynchronously.");
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
    if (expression.kind === "format") {
      const parts: InterpolatedInput["parts"] = [];
      for (const part of expression.parts) {
        if (part.kind === "text") {
          if (part.text) parts.push(part.text);
          continue;
        }
        const value = await this.evaluateAsync(part.expression, environment, metadata);
        if (typeof value === "string") parts.push(value);
        else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          parts.push(value as Exclude<InterpolatedInput["parts"][number], string>);
        } else {
          throw new Error("Dext input f-string interpolation resolved to an unsupported value.");
        }
      }
      return { kind: "interpolatedInput", parts };
    }
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
      } else {
        this.markSkipped(statement.consequent, steps);
        this.markSkipped(statement.alternate, steps);
      }
    }
  }
}
