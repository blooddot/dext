import type { DextRuntime } from "./runtime.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import type {
  DextResult,
  InputExecutionResponse,
  InvocationValue,
  WorkflowCondition,
  WorkflowExpression,
  WorkflowProgram,
  WorkflowStatement,
  WorkflowStepResponse
} from "./types.js";

type RuntimeValue = InvocationValue | DextResult;

export class WorkflowRuntime {
  constructor(private readonly runtime: DextRuntime) {}

  async execute(program: WorkflowProgram): Promise<InputExecutionResponse> {
    const environment = new Map<string, RuntimeValue>();
    const steps: WorkflowStepResponse[] = [];
    await this.executeStatements(program.statements, environment, steps);
    return {
      kind: "workflow",
      executions: steps.flatMap((step) => step.response ? [step.response] : []),
      steps
    };
  }

  private async executeStatements(
    statements: readonly WorkflowStatement[],
    environment: Map<string, RuntimeValue>,
    steps: WorkflowStepResponse[]
  ): Promise<boolean> {
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]!;
      if (statement.kind === "if") {
        const condition = this.evaluateCondition(statement.condition, environment);
        const selected = condition ? statement.consequent : statement.alternate;
        const skipped = condition ? statement.alternate : statement.consequent;
        this.markSkipped(skipped, steps);
        if (!await this.executeStatements(selected, environment, steps)) {
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
          arguments: statement.call.arguments.map((argument) => ({
            name: argument.name,
            value: this.evaluate(argument.value, environment) as InvocationValue
          }))
        });
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
    if (expression.kind === "variable") {
      const value = environment.get(expression.name);
      if (value === undefined) throw new Error(`Variable '${expression.name}' is unavailable.`);
      return value;
    }
    const object = this.evaluate(expression.object, environment);
    if (typeof object !== "object" || object === null || Array.isArray(object)) {
      throw new Error(`Cannot read '${expression.property}' from a non-object value.`);
    }
    const value = (object as unknown as Record<string, RuntimeValue>)[expression.property];
    if (value === undefined) throw new Error(`Result field '${expression.property}' is unavailable.`);
    return value;
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
