// Import the ESM entry explicitly. The package's bare entry points at a UMD
// wrapper whose relative requires survive esbuild bundling and fail at runtime
// in the extension host ("Cannot find module './impl/format'").
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import type { CallableDefinition, FieldDefinition } from "./types.js";
import type { McpServerConfig, McpToolConfig } from "./mcpRegistry.js";

const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaFields(schema: Record<string, unknown>, label: string, diagnostics: string[]): FieldDefinition[] | undefined {
  if (schema.type !== "object") {
    diagnostics.push(`${label} must be a JSON Schema object with type 'object'.`);
    return undefined;
  }
  const properties = schema.properties;
  if (properties !== undefined && !isRecord(properties)) {
    diagnostics.push(`${label}.properties must be an object.`);
    return undefined;
  }
  const required = schema.required;
  if (required !== undefined && (!Array.isArray(required) || required.some((name) => typeof name !== "string"))) {
    diagnostics.push(`${label}.required must be an array of property names.`);
    return undefined;
  }
  const requiredNames = new Set(required ?? []);
  const fields: FieldDefinition[] = [];
  for (const [name, raw] of Object.entries(properties ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      diagnostics.push(`${label} property '${name}' is not a valid Dext parameter name.`);
      continue;
    }
    const property = isRecord(raw) ? raw : {};
    const schemaType = property.type;
    const enumValues = Array.isArray(property.enum) && property.enum.every((value) => typeof value === "string")
      ? property.enum
      : undefined;
    const type: FieldDefinition["type"] = enumValues?.length
      ? "enum"
      : schemaType === "string" ? "string"
        : schemaType === "number" || schemaType === "integer" ? "number"
          : schemaType === "boolean" ? "boolean"
            : schemaType === "array" ? "list"
              : "object";
    fields.push({
      name,
      type,
      required: requiredNames.has(name),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      ...(enumValues?.length ? { values: enumValues } : {})
    });
  }
  return fields;
}

function resultTypeName(server: string, tool: string): string {
  return `${server}.${tool}`.split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join("") + "Result";
}

export interface McpManifestLoad {
  server?: McpServerConfig;
  tools: McpToolConfig[];
  methods: CallableDefinition[];
  diagnostics: string[];
}

/** Parses one committed `.dext/mcp/*.jsonc` manifest. Secrets deliberately do
 * not have syntax here: server credentials belong in VS Code SecretStorage. */
export function parseMcpManifest(source: string, path: string): McpManifestLoad {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  const diagnostics: string[] = errors.map((error) => `${path}: invalid JSONC near offset ${error.offset}.`);
  if (!isRecord(value)) return { tools: [], methods: [], diagnostics: [...diagnostics, `${path}: MCP manifest must be an object.`] };
  const name = value.name;
  if (typeof name !== "string" || !IDENTIFIER.test(name)) {
    return { tools: [], methods: [], diagnostics: [...diagnostics, `${path}: MCP manifest requires a valid 'name'.`] };
  }
  const rawTools = value.tools;
  if (!Array.isArray(rawTools)) {
    return { tools: [], methods: [], diagnostics: [...diagnostics, `${path}: MCP manifest requires a 'tools' array.`] };
  }
  const server = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "tools")) as unknown as McpServerConfig;
  const tools: McpToolConfig[] = [];
  const methods: CallableDefinition[] = [];
  for (const rawTool of rawTools) {
    if (!isRecord(rawTool)) {
      diagnostics.push(`${path}: every MCP tool requires a valid 'name'.`);
      continue;
    }
    // Older Dext builds wrote the registry's flattened `{server, tool}` shape
    // into manifests. Accept that shape when it belongs to this server so an
    // existing configuration can be repaired on the next save, while keeping
    // the canonical on-disk form as `{name, ...}`.
    const legacyName = rawTool.server === name && typeof rawTool.tool === "string" ? rawTool.tool : undefined;
    const toolName = typeof rawTool.name === "string" ? rawTool.name : legacyName;
    if (!toolName || !IDENTIFIER.test(toolName)) {
      diagnostics.push(`${path}: every MCP tool requires a valid 'name'.`);
      continue;
    }
    const inputSchema = rawTool.inputSchema;
    if (!isRecord(inputSchema)) {
      diagnostics.push(`${path}: MCP tool '${toolName}' requires an object 'inputSchema'.`);
      continue;
    }
    const input = schemaFields(inputSchema, `${path}: MCP tool '${toolName}' inputSchema`, diagnostics);
    if (!input) continue;
    const outputSchema = rawTool.outputSchema;
    const output = outputSchema === undefined
      ? undefined
      : isRecord(outputSchema)
        ? schemaFields(outputSchema, `${path}: MCP tool '${toolName}' outputSchema`, diagnostics)
        : (diagnostics.push(`${path}: MCP tool '${toolName}' outputSchema must be an object.`), undefined);
    if (outputSchema !== undefined && !output) continue;
    const description = typeof rawTool.description === "string" ? rawTool.description : `MCP tool ${name}.${toolName}.`;
    // A schema without named properties still gives the server a contract, but
    // it cannot safely become a closed Dext result object with field completion.
    const typedOutput = output && isRecord(outputSchema) && isRecord(outputSchema.properties) ? output : undefined;
    tools.push({ server: name, tool: toolName, description, inputSchema, ...(isRecord(outputSchema) ? { outputSchema } : {}) });
    const id = `mcp.${name}.${toolName}`;
    methods.push({
      id,
      title: rawTool.title && typeof rawTool.title === "string" ? rawTool.title : `${name}.${toolName}`,
      description,
      kind: "command",
      version: "1.0.0",
      input,
      output: typedOutput
        ? { kind: id, fields: typedOutput, resultType: resultTypeName(name, toolName), description: `Structured result from ${name}.${toolName}.` }
        : { kind: "mcpRaw", description: `Raw result from ${name}.${toolName}.` },
      executor: { kind: "deterministic", handler: "mcpTool" }
    });
  }
  return { server, tools, methods, diagnostics };
}
