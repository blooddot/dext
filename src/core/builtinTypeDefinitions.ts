/**
 * Public result shapes exposed by the Dext workflow language.  This is kept
 * independent of the runtime TypeScript interfaces so editor features can
 * describe the language contract without exposing host-only fields.
 */
import { NODE_BUILTIN_CATALOG } from "./generated/nodeBuiltinCatalog.js";
import { BUILTIN_METHODS } from "./builtins.js";
import { formatFieldType } from "./methodSignature.js";
import { pythonType } from "./pythonType.js";
import { nodeBuiltinResultType } from "./builtinResultTypes.js";
export interface BuiltinTypeField {
  name: string;
  type: string;
  optional?: boolean;
  description?: string;
}

export interface BuiltinTypeDefinition {
  name: string;
  description: string;
  fields: readonly BuiltinTypeField[];
}

const staticTypes: readonly BuiltinTypeDefinition[] = [
  { name: "AskResult", description: "Text returned by Ask.", fields: [
    { name: "kind", type: '"ask"' }, { name: "text", type: "string" }
  ] },
  { name: "PlanResult", description: "Text returned by Plan and its optional saved-plan state.", fields: [
    { name: "kind", type: '"plan"' }, { name: "text", type: "string" }, { name: "planPath", type: "string", optional: true },
    { name: "executePlan", type: "boolean", optional: true }, { name: "planOutcome", type: "object", optional: true }
  ] },
  { name: "SkillResult", description: "Text returned after executing a skill.", fields: [
    { name: "kind", type: '"skill"' }, { name: "text", type: "string" }
  ] },
  { name: "AgentResult", description: "Result of a continuous Agent task; preview-only edits may include a patch.", fields: [
    { name: "kind", type: '"agent"' }, { name: "text", type: "string" }, { name: "summary", type: "string", optional: true },
    { name: "patch", type: "PatchResult", optional: true }, { name: "files", type: "CodeRef[]", optional: true }
  ] },
  { name: "ApplyResult", description: "Outcome of applying a patch.", fields: [
    { name: "kind", type: '"apply"' }, { name: "status", type: '"applied" | "unchanged" | "conflict"' }, { name: "summary", type: "string" }, { name: "files", type: "CodeRef[]" }
  ] },
  { name: "TerminalResult", description: "Captured execution of a terminal command.", fields: [
    { name: "kind", type: '"terminal"' }, { name: "status", type: '"succeeded" | "failed" | "timed_out"' }, { name: "command", type: "string" }, { name: "cwd", type: "string" },
    { name: "exit_code", type: "number" }, { name: "stdout", type: "string" }, { name: "stderr", type: "string" }, { name: "duration_ms", type: "number" }
  ] },
  { name: "PrintResult", description: "Value rendered in Dext Output.", fields: [
    { name: "kind", type: '"print"' }, { name: "text", type: "string" }, { name: "label", type: "string", optional: true }
  ] },
  { name: "PatchResult", description: "An auditable set of document changes.", fields: [
    { name: "kind", type: '"patch"' }, { name: "title", type: "string" }, { name: "changes", type: "PatchChange[]" }
  ] },
  { name: "UiResult", description: "Result returned by a Dext UI interaction.", fields: [
    { name: "kind", type: '"ui"' }, { name: "type", type: '"select" | "radio" | "checkbox" | "confirm" | "input" | "form" | "alert"' },
    { name: "selected", type: "string[]" }, { name: "custom", type: "string", optional: true }, { name: "confirmed", type: "boolean" }, { name: "value", type: "string", optional: true },
    { name: "action", type: "string", optional: true, description: "Form only: the pressed action button's ID." }
  ] },
  { name: "CodeRef", description: "Reference to a code location and its captured content.", fields: [
    { name: "kind", type: '"codeRef"' }, { name: "uri", type: "string" }, { name: "range", type: "Range", optional: true }, { name: "symbol", type: "string", optional: true },
    { name: "documentVersion", type: "number" }, { name: "contentHash", type: "string" }, { name: "content", type: "string" }
  ] },
  { name: "PatchChange", description: "One document change in a patch.", fields: [
    { name: "uri", type: "string" }, { name: "before", type: "string" }, { name: "after", type: "string" }, { name: "range", type: "Range", optional: true },
    { name: "documentVersion", type: "number", optional: true }, { name: "contentHash", type: "string", optional: true }
  ] },
  { name: "Range", description: "A range in a text document.", fields: [
    { name: "start", type: "Position" }, { name: "end", type: "Position" }
  ] },
  { name: "Position", description: "A zero-based position in a text document.", fields: [
    { name: "line", type: "number" }, { name: "character", type: "number" }
  ] },
  { name: "ui.Option", description: "A labelled option accepted by a selection field.", fields: [
    { name: "value", type: "string" }, { name: "label", type: "string" }, { name: "description", type: "string", optional: true }
  ] },
  { name: "ui.Action", description: "A submit button. The pressed button's ID is returned as the result's `action`.", fields: [
    { name: "id", type: "string" }, { name: "label", type: "string" }, { name: "description", type: "string", optional: true },
    { name: "primary", type: "boolean", optional: true, description: "Highlighted button and the one Enter submits. Defaults to the first action." },
    { name: "requires", type: "list[string]", optional: true, description: "Field IDs this action must have answered, even when the field itself is optional." }
  ] },
  { name: "ui.Field", description: "Base form field. The `type` discriminator selects a concrete field variant.", fields: [
    { name: "id", type: "string" }, { name: "type", type: '"select" | "radio" | "checkbox" | "input"' }, { name: "label", type: "string" },
    { name: "description", type: "string", optional: true }, { name: "required", type: "boolean", optional: true },
    { name: "options", type: "list[string | ui.Option]", optional: true, description: "Required for select, radio, and checkbox." },
    { name: "default", type: "string | list[string]", optional: true, description: "A string for input, otherwise selected option values." },
    { name: "multiple", type: "boolean", optional: true, description: "Available only for select." },
    { name: "allow_custom", type: "boolean", optional: true, description: "Available only for radio and checkbox." },
    { name: "custom_placeholder", type: "string", optional: true, description: "Available only for radio and checkbox." },
    { name: "placeholder", type: "string", optional: true }, { name: "multiline", type: "boolean", optional: true, description: "Available only for input." }
  ] },
  { name: "ui.SelectField", description: "Selectable form field.", fields: [
    { name: "options", type: "list[string | ui.Option]" }, { name: "default", type: "list[string]", optional: true }, { name: "multiple", type: "boolean", optional: true }, { name: "placeholder", type: "string", optional: true }
  ] },
  { name: "ui.RadioField", description: "Single-choice field with an optional custom response.", fields: [
    { name: "options", type: "list[string | ui.Option]" }, { name: "default", type: "list[string]", optional: true }, { name: "allow_custom", type: "boolean", optional: true }, { name: "custom_placeholder", type: "string", optional: true }
  ] },
  { name: "ui.CheckboxField", description: "Multiple-choice field with an optional custom response.", fields: [
    { name: "options", type: "list[string | ui.Option]" }, { name: "default", type: "list[string]", optional: true }, { name: "allow_custom", type: "boolean", optional: true }, { name: "custom_placeholder", type: "string", optional: true }
  ] },
  { name: "ui.InputField", description: "Free-text form field.", fields: [
    { name: "default", type: "string", optional: true }, { name: "placeholder", type: "string", optional: true }, { name: "multiline", type: "boolean", optional: true }
  ] },
  { name: "agent.ModelOptions", description: "Codex per-call model selection options.", fields: [
    { name: "model", type: "string" }, { name: "reasoning", type: '"low" | "medium" | "high" | "xhigh" | "max" | "ultra"', optional: true }, { name: "speed", type: '"standard" | "fast"', optional: true }
  ] }
];

const nodeTypes: readonly BuiltinTypeDefinition[] = NODE_BUILTIN_CATALOG.map(({ method }) => ({
  name: nodeBuiltinResultType(method.id),
  description: `Result returned by ${method.id}.`,
  fields: [
    { name: "kind", type: '"node"' },
    ...(method.output.fields ?? []).map((field) => ({
      name: field.name,
      type: formatFieldType(field),
      ...(field.required ? {} : { optional: true }),
      ...(field.description ? { description: field.description } : {})
    }))
  ]
}));

const declaredOutputTypes: readonly BuiltinTypeDefinition[] = BUILTIN_METHODS
  .filter((method) => method.output.resultType && method.output.fields)
  .map((method) => ({
    name: method.output.resultType!,
    description: method.output.description ?? `Result returned by ${method.id}.`,
    fields: method.output.fields!.map((field) => ({
      name: field.name,
      type: formatFieldType(field),
      ...(field.required ? {} : { optional: true }),
      ...(field.description ? { description: field.description } : {})
    }))
  }));

const answerFields = BUILTIN_METHODS.find((method) => method.id === "ui.form")!
  .output.fields!.find((field) => field.name === "answers")!.properties!;

const types: readonly BuiltinTypeDefinition[] = [...staticTypes, ...declaredOutputTypes, ...nodeTypes, {
  name: "UiFieldAnswer",
  description: "Answer for one form field. Selection fields expose selected; input fields expose value. Radio and checkbox fields may also expose custom.",
  fields: answerFields.map((field) => ({
    name: field.name, type: formatFieldType(field), ...(field.required ? {} : { optional: true })
  }))
}];

const byName = new Map(types.map((definition) => [definition.name, definition]));

export function builtinTypeDefinition(name: string): BuiltinTypeDefinition | undefined {
  return byName.get(name);
}

export function builtinTypeSignature(definition: BuiltinTypeDefinition): string {
  return `${definition.name} { ${definition.fields.map((field) => `${field.name}${field.optional ? "?" : ""}: ${field.type}`).join("; ")} }`;
}

/** Type of a field on a standard command result, including undefined for optional fields. */
export function builtinResultFieldType(kind: string, fieldName: string): string | undefined {
  const definition = builtinTypeDefinition(`${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}Result`);
  const field = definition?.fields.find((candidate) => candidate.name === fieldName);
  return field ? `${field.type}${field.optional ? " | undefined" : ""}` : undefined;
}

export interface BuiltinTypeDocument {
  text: string;
  ranges: ReadonlyMap<string, { from: number; to: number; nameFrom: number; nameTo: number }>;
  fieldRanges: ReadonlyMap<string, { from: number; to: number; nameFrom: number; nameTo: number }>;
}

/** Render the read-only document used by Go to Definition and Peek Definition. */
export function builtinTypeDocument(): BuiltinTypeDocument {
  let text = "# Dext Built-in Types\n\n";
  const ranges = new Map<string, { from: number; to: number; nameFrom: number; nameTo: number }>();
  const fieldRanges = new Map<string, { from: number; to: number; nameFrom: number; nameTo: number }>();
  const render = (definition: BuiltinTypeDefinition, name: string, depth: number): void => {
    const from = text.length;
    const indent = "    ".repeat(depth);
    text += `${indent}# Type: ${definition.name}\n`;
    text += `${indent}# ${definition.description}\n`;
    const nameFrom = text.length + indent.length + "class ".length;
    text += `${indent}class ${name}:\n`;
    for (const field of definition.fields) {
      // The document is presented as Python, so nested object shapes must use
      // Python annotations (`x: str | None`) instead of TypeScript (`x?: string`).
      const type = pythonType(field.type);
      const fieldFrom = text.length;
      const fieldNameFrom = fieldFrom + 4 * (depth + 1);
      text += `${"    ".repeat(depth + 1)}${field.name}: ${type}${field.optional ? " | None" : ""}\n`;
      fieldRanges.set(`${definition.name}.${field.name}`, {
        from: fieldFrom, to: text.length - 1, nameFrom: fieldNameFrom, nameTo: fieldNameFrom + field.name.length
      });
    }
    text += "\n";
    ranges.set(definition.name, { from, to: text.length - 1, nameFrom, nameTo: nameFrom + name.length });
  };
  const groups = new Map<string, BuiltinTypeDefinition[]>();
  for (const definition of types) {
    const [namespace, name] = definition.name.split(".");
    if (!name) render(definition, namespace!, 0);
    else groups.set(namespace!, [...(groups.get(namespace!) ?? []), definition]);
  }
  for (const [namespace, definitions] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const from = text.length;
    const nameFrom = text.length + "class ".length;
    text += `# Namespace: ${namespace}\nclass ${namespace}:\n`;
    for (const definition of definitions.sort((left, right) => left.name.localeCompare(right.name))) {
      render(definition, definition.name.slice(namespace.length + 1), 1);
    }
    text += "\n";
    ranges.set(namespace, { from, to: text.length - 1, nameFrom, nameTo: nameFrom + namespace.length });
  }
  return { text, ranges, fieldRanges };
}
