import { f, type AxSignature } from "@ax-llm/ax";
import { z, type ZodType } from "zod";
import {
  codeResultSchema,
  dextResultSchema,
  patchResultSchema,
  planResultSchema,
  reviewResultSchema,
  textResultSchema
} from "./schemas.js";
import type {
  CallableDefinition,
  ContextReference,
  DextResult,
  FieldDefinition,
  InvocationValue
} from "./types.js";

export interface AxMethodContract {
  methodId: string;
  signature: AxSignature;
  inputSchema: ZodType;
  outputSchema: ZodType;
  inputJsonSchema: object;
  outputJsonSchema: object;
}

const contextReferenceSchema: ZodType<ContextReference> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selection") }).strict(),
  z.object({ kind: z.literal("activeFile") }).strict(),
  z.object({ kind: z.literal("file"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("symbol"), name: z.string().min(1) }).strict()
]);

function scalarSchema(field: FieldDefinition): ZodType {
  switch (field.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "enum":
      if (!field.values?.length) {
        throw new Error(`Enum field '${field.name}' requires at least one value.`);
      }
      return z.enum(field.values as [string, ...string[]]);
    case "context":
      return contextReferenceSchema;
  }
}

function inputSchema(definition: CallableDefinition): ZodType {
  const shape: Record<string, ZodType> = {};
  for (const field of definition.input) {
    let schema = field.multiple ? z.array(scalarSchema(field)) : scalarSchema(field);
    if (!field.required) {
      schema = schema.optional();
    }
    shape[field.name] = schema;
  }
  return z.object(shape).strict();
}

function outputSchema(kind: CallableDefinition["output"]["kind"]): ZodType {
  switch (kind) {
    case "text":
      return textResultSchema;
    case "code":
      return codeResultSchema;
    case "review":
      return reviewResultSchema;
    case "plan":
      return planResultSchema;
    case "patch":
      return patchResultSchema;
  }
}

export class AxAdapter {
  compile(definition: CallableDefinition): AxMethodContract {
    const input = inputSchema(definition);
    const output = outputSchema(definition.output.kind);
    const signature = f()
      .input("invocationArguments", input.describe("Typed Dext invocation arguments."))
      .output(
        "structuredOutput",
        output.describe(definition.output.description ?? "Typed Dext result.")
      )
      .description(definition.description)
      .useStructured()
      .build();
    return {
      methodId: definition.id,
      signature,
      inputSchema: input,
      outputSchema: output,
      inputJsonSchema: z.toJSONSchema(input),
      outputJsonSchema: z.toJSONSchema(output)
    };
  }

  validateInput(contract: AxMethodContract, value: Record<string, InvocationValue>): void {
    contract.inputSchema.parse(value);
  }

  validateOutput(contract: AxMethodContract, result: DextResult): DextResult {
    contract.outputSchema.parse(result);
    return dextResultSchema.parse(result) as DextResult;
  }
}
