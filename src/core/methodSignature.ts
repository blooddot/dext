import type { FieldDefinition, RegisteredCallable } from "./types.js";

function literal(value: string): string {
  return JSON.stringify(value);
}

function scalarType(type: FieldDefinition["type"], field: FieldDefinition): string {
  if (type === "object") return "dict[str, object]";
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
export function methodResultType(method: Pick<RegisteredCallable, "output">): string {
  return method.output.resultType
    ?? `${method.output.kind.slice(0, 1).toUpperCase()}${method.output.kind.slice(1)}Result`;
}

/** Render the complete public call contract for a Dext API. */
export function formatMethodSignature(method: Pick<RegisteredCallable, "id" | "input" | "output">): string {
  return `${method.id}(${method.input.map(formatMethodParameter).join(", ")}) -> ${methodResultType(method)}`;
}
