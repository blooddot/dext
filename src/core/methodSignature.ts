import type { FieldDefinition, RegisteredCallable } from "./types.js";

function literal(value: string): string {
  return JSON.stringify(value);
}

function scalarType(type: FieldDefinition["type"], field: FieldDefinition): string {
  if ((type === "object" || type === "list") && field.shapeType) return field.shapeType;
  if (type === "result" && field.resultType) return field.resultType;
  if (type === "object") return field.properties?.length
    ? `{ ${field.properties.map(formatMethodParameter).join(", ")} }`
    : "dict[str, object]";
  if (type === "list") return `list[${field.items ? scalarType(field.items.type, field.items) : "object"}]`;
  if (type !== "enum") return type;
  const values = field.values ?? [];
  return values.length ? values.map(literal).join(" | ") : "string";
}

/** Render the accepted Dext value type for an API field. */
export function formatFieldType(field: FieldDefinition): string {
  const types = [field.type, ...(field.accepts ?? [])]
    .map((type) => scalarType(type, field));
  const scalar = [...new Set(types)].join(" | ");
  if (!field.multiple) return scalar;
  const wrap = types.length > 1 || scalar.includes(" | ");
  const arrayElement = wrap ? `(${scalar})` : scalar;
  return `${scalar} | ${arrayElement}[]`;
}

function formatDefault(value: FieldDefinition["default"]): string {
  if (typeof value === "string") return literal(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Render one parameter as it appears in a Dext API signature. */
export function formatMethodParameter(field: FieldDefinition): string {
  const optional = field.required ? "" : "?";
  const defaultValue = field.default === undefined ? "" : ` = ${formatDefault(field.default)}`;
  return `${field.name}${optional}: ${formatFieldType(field)}${defaultValue}`;
}

/** Resolve the named result type exposed by an API. */
export function methodResultType(method: Pick<RegisteredCallable, "id" | "output">): string {
  return method.output.resultType
    ?? `${method.output.kind.slice(0, 1).toUpperCase()}${method.output.kind.slice(1)}Result`;
}

/**
 * The methods that take free-form conversation input plus the `skills` and `rules` that
 * scope a single call.
 *
 * Those two fields are `internal` because they are never forwarded to a provider as
 * control fields, but for exactly these APIs they are caller-facing options: a surface
 * that lists what a caller may pass — the generated declaration, the reference signature,
 * the resource panel — keeps them, while every other `internal` field stays runtime-only.
 */
export const CONVERSATION_METHODS: ReadonlySet<string> = new Set(["ask", "plan", "agent", "template"]);
