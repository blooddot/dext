import { f, type AxSignature } from "@ax-llm/ax";
import { z, type ZodType } from "zod";
import { formatDiagnostics } from "./resultBoundary.js";
import {
  askResultSchema,
  agentResultSchema,
  templateResultSchema,
  dextResultSchema,
  applyResultSchema,
  patchResultSchema,
  printResultSchema,
  planResultSchema,
  skillResultSchema,
  terminalResultSchema,
  uiResultSchema,
  nodeResultSchema,
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
      if (field.properties?.length) {
        const shape: Record<string, ZodType> = {};
        for (const property of field.properties) {
          let schema = scalarSchema(property);
          if (!property.required) schema = schema.optional();
          shape[property.name] = schema;
        }
        return z.object(shape).passthrough();
      }
      return z.record(z.string(), z.unknown());
    case "list":
      return field.items ? z.array(scalarSchema(field.items)) : z.array(z.unknown());
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
      return field.resultType
        ? dextResultSchema.refine((value) => matchesResultAnnotation(value, field.resultType!), `Expected ${field.resultType}.`)
        : dextResultSchema;
  }
}

function scalarSchema(field: FieldDefinition): ZodType {
  const types = [field.type, ...(field.accepts ?? [])];
  const schemas = types.map((type) => scalarSchemaForType(field, type));
  const schema = schemas.length === 1 ? schemas[0]! : z.union(schemas as [ZodType, ZodType, ...ZodType[]]);
  return field.nullable ? schema.nullable() : schema;
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
  // UI field metadata describes editor hints, including a dynamic answer map.
  // The executable contract must always use the strict result union instead.
  if (output.kind === "ui") return output.resultType
    ? uiResultSchema.refine((value) => matchesResultAnnotation(value, output.resultType!), `Expected ${output.resultType}.`)
    : uiResultSchema;
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
    case "ask":
      return askResultSchema;
    case "plan":
      return planResultSchema;
    case "agent":
      return agentResultSchema;
    case "template":
      return templateResultSchema;
    case "apply":
      return applyResultSchema;
    case "terminal":
      return terminalResultSchema;
    case "print":
      return printResultSchema;
    case "skill":
      return skillResultSchema;
    case "patch":
      return patchResultSchema;
    case "ui":
      return uiResultSchema;
    case "node":
      return nodeResultSchema;
    case "mcpRaw":
      return mcpRawResultSchema;
    default:
      throw new Error(`Output kind '${output.kind}' requires a TypedDict result declaration.`);
  }
}

function matchesResultAnnotation(value: { kind: string }, name: string): boolean {
  if (`${value.kind}Result`.toLowerCase() === name.toLowerCase()) return true;
  return value.kind === "ui" && "type" in value && typeof value.type === "string" && `Ui${value.type}Result`.toLowerCase() === name.toLowerCase();
}

/** The single output field every ax-backed repair signature uses. */
export const REPAIR_OUTPUT_FIELD = "structuredOutput";

/** Signature for the bounded, single-retry result repair predictor. It carries
 * the raw agent text plus zod diagnostics and produces the typed result object
 * the contract expects.
 *
 * The output field is deliberately opaque. Attaching the contract makes ax walk it and JSON.parse
 * the elements of every string-array leaf, so a contract that declares `list[str]` (or
 * `UiResult.selected`) rejects an answer that already satisfies it, and the repair can never
 * succeed. `ResultRepair` validates the answer with `contract.outputSchema` instead and hands that
 * diagnostic back to ax's own fixing loop. */
export function repairSignature(): AxSignature {
  return f()
    .input("agentOutput", z.string())
    .input("diagnostics", z.string())
    .output(REPAIR_OUTPUT_FIELD, z.unknown())
    .description("Convert a raw agent result and its validation diagnostics into the required Dext result.")
    .useStructured()
    .build();
}

export class AxAdapter {
  compile(definition: CallableDefinition): AxMethodContract {
    return this.compileOutput(definition, outputSchema(definition.output));
  }

  /**
   * Compiles a call whose output contract is supplied by the caller instead of
   * the definition. `template` uses this: the template file decides which fields
   * the model must return, so the CLI's native structured-output schema is the
   * template's field schema rather than a fixed built-in result.
   */
  compileOutput(definition: CallableDefinition, output: ZodType): AxMethodContract {
    const input = inputSchema(definition);
    const signature = f()
      .input("invocationArguments", input)
      .output("structuredOutput", output)
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

  /** Non-throwing validation for callers that report diagnostics instead of
   * raising (workflowRuntime). The returned result copies the existing
   * validateOutput semantics, including the builtin-result narrowing. */
  inspectOutput(contract: AxMethodContract, result: unknown):
    | { success: true; data: DextResult }
    | { success: false; diagnostics: string } {
    const parsed = contract.outputSchema.safeParse(result);
    if (!parsed.success) return { success: false, diagnostics: formatDiagnostics(parsed.error) };
    const builtin = dextResultSchema.safeParse(parsed.data);
    return { success: true, data: (builtin.success ? builtin.data : parsed.data) as DextResult };
  }

  validateOutput(contract: AxMethodContract, result: DextResult): DextResult {
    const inspected = this.inspectOutput(contract, result);
    if (!inspected.success) throw new Error(inspected.diagnostics);
    return inspected.data;
  }
}
