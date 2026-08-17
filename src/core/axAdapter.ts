import { f, type AxSignature } from "@ax-llm/ax";
import { z, type ZodType } from "zod";
import {
  codeResultSchema,
  chatResultSchema,
  agentResultSchema,
  dextResultSchema,
  editResultSchema,
  explainResultSchema,
  applyResultSchema,
  patchResultSchema,
  planResultSchema,
  printResultSchema,
  reviewResultSchema,
  terminalResultSchema,
  textResultSchema,
  uiResultSchema,
  mcpRawResultSchema
} from "./schemas.js";
import type {
  CallableDefinition,
  ContextReference,
  DextResult,
  DirectoryReference,
  DirRef,
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

const codeRefSchema = z.object({
  kind: z.literal("codeRef"),
  uri: z.string(),
  documentVersion: z.number(),
  contentHash: z.string(),
  content: z.string()
}).passthrough();

const directoryReferenceSchema: ZodType<DirectoryReference | DirRef> = z.union([
  z.object({ kind: z.literal("dir"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("dirRef"), uri: z.string(), path: z.string().min(1) }).strict()
]);

function scalarSchemaForType(field: FieldDefinition, type: FieldDefinition["type"]): ZodType {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "object":
      return z.record(z.string(), z.unknown());
    case "enum":
      if (!field.values?.length) {
        throw new Error(`Enum field '${field.name}' requires at least one value.`);
      }
      return z.enum(field.values as [string, ...string[]]);
    case "context":
      return z.union([contextReferenceSchema, codeRefSchema]);
    case "dir":
      return directoryReferenceSchema;
    case "result":
      return dextResultSchema;
  }
}

function scalarSchema(field: FieldDefinition): ZodType {
  const types = [field.type, ...(field.accepts ?? [])];
  const schemas = types.map((type) => scalarSchemaForType(field, type));
  return schemas.length === 1 ? schemas[0]! : z.union(schemas as [ZodType, ZodType, ...ZodType[]]);
}

function inputSchema(definition: CallableDefinition): ZodType {
  const shape: Record<string, ZodType> = {};
  for (const field of definition.input) {
    const scalar = scalarSchema(field);
    let schema = field.multiple ? z.union([scalar, z.array(scalar)]) : scalar;
    if (field.default !== undefined) {
      schema = schema.default(field.default);
    } else if (!field.required) {
      schema = schema.optional();
    }
    shape[field.name] = schema;
  }
  return z.object(shape).strict();
}

function outputSchema(output: CallableDefinition["output"]): ZodType {
  if (output.fields) {
    const shape: Record<string, ZodType> = { kind: z.literal(output.kind) };
    for (const field of output.fields) {
      const scalar = scalarSchema(field);
      let schema = field.multiple ? z.array(scalar) : scalar;
      if (!field.required) schema = schema.optional();
      shape[field.name] = schema;
    }
    return z.object(shape).strict();
  }
  switch (output.kind) {
    case "chat":
      return chatResultSchema;
    case "agent":
      return agentResultSchema;
    case "explain":
      return explainResultSchema;
    case "edit":
      return editResultSchema;
    case "apply":
      return applyResultSchema;
    case "terminal":
      return terminalResultSchema;
    case "print":
      return printResultSchema;
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
    case "ui":
      return uiResultSchema;
    case "mcpRaw":
      return mcpRawResultSchema;
    default:
      throw new Error(`Output kind '${output.kind}' requires a TypedDict result declaration.`);
  }
}

export class AxAdapter {
  compile(definition: CallableDefinition): AxMethodContract {
    const input = inputSchema(definition);
    const output = outputSchema(definition.output);
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
    const parsed = contract.outputSchema.parse(result);
    const builtin = dextResultSchema.safeParse(parsed);
    return (builtin.success ? builtin.data : parsed) as DextResult;
  }
}
