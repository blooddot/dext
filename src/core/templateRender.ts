import { parse as parseTomlSource } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { z, type ZodType } from "zod";

/**
 * A Dext template is a file whose YAML front matter declares the fields a model
 * must fill, and whose body places those fields with `{{name}}` placeholders.
 *
 * The split matters: the model only produces field values, while Dext renders
 * the output skeleton from the template file. A model can therefore never change
 * the heading structure, the section order, or the list markers, which is
 * exactly what a prompt-only rule cannot guarantee.
 *
 * `format` is required and decides how the body is read: `markdown` owns the
 * heading and blank-line rules, while every other format is rendered literally
 * and then parsed, so a render that is not valid JSON, TOML or YAML is a
 * validation failure the one-shot repair can fix.
 */
export const TEMPLATE_KEY = "dext-template";

/** The syntax of the rendered output. `markdown` and `text` have no syntax to
 * check; `json`, `toml` and `yaml` must parse after rendering. */
export type TemplateFormat = "markdown" | "text" | "json" | "toml" | "yaml";

export const TEMPLATE_FORMATS: readonly TemplateFormat[] = ["markdown", "text", "json", "toml", "yaml"];

export type TemplateFieldType = "string" | "lines" | "enum";

export interface TemplateFieldSpec {
  name: string;
  type: TemplateFieldType;
  description: string;
  optional: boolean;
  /** Allowed values for an `enum` field. */
  values?: readonly string[];
  /** Inserted between the repeated placeholder lines of a `lines` field, so a
   * JSON or TOML array can carry its own commas. Defaults to a newline. */
  separator?: string;
}

export interface TemplateSpec {
  /** Where the template came from, used in diagnostics. */
  label: string;
  format: TemplateFormat;
  fields: readonly TemplateFieldSpec[];
  body: string;
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PLACEHOLDER_SOURCE = "\\{\\{\\s*([A-Za-z_][A-Za-z0-9_-]*)\\s*\\}\\}";
const FIELD_OPTIONS = ["type", "description", "optional", "values", "separator"];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(new RegExp(PLACEHOLDER_SOURCE, "g"))].map((match) => match[1]!);
}

function stripPlaceholders(text: string): string {
  return text.replace(new RegExp(PLACEHOLDER_SOURCE, "g"), "");
}

function substitute(
  text: string,
  resolve: (name: string) => string | undefined
): string {
  return text.replace(new RegExp(PLACEHOLDER_SOURCE, "g"), (_match, name: string) => resolve(name) ?? "");
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** A `lines` field is one item per line on the wire. Only a Markdown template
 * supplies its own list markers, so only there must a model that added markers
 * anyway not produce a doubled bullet; in every other format a marker is part of
 * the value and a stray one becomes a format error the model has to fix. */
function listItems(value: string, stripMarkers: boolean): string[] {
  const items = value.split("\n").map((line) => line.trim());
  return (stripMarkers ? items.map((line) => line.replace(/^[-*+]\s+/, "").trim()) : items).filter(Boolean);
}

function parseField(name: string, raw: unknown, label: string): TemplateFieldSpec {
  if (typeof raw === "string") return { name, type: "string", description: raw.trim(), optional: false };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${label}: field '${name}' must be a description string or a mapping.`);
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !FIELD_OPTIONS.includes(key));
  if (unknown) throw new Error(`${label}: field '${name}' has an unsupported option '${unknown}'.`);
  const type = record.type ?? "string";
  if (type !== "string" && type !== "lines" && type !== "enum") {
    throw new Error(`${label}: field '${name}' has an unsupported type ${JSON.stringify(type)}; use string, lines or enum.`);
  }
  let values: string[] | undefined;
  if (type === "enum") {
    if (!Array.isArray(record.values) || !record.values.length || !record.values.every((item) => typeof item === "string" && item.trim())) {
      throw new Error(`${label}: enum field '${name}' requires a non-empty list of string values.`);
    }
    values = record.values.map((item) => (item as string).trim());
    if (new Set(values).size !== values.length) {
      throw new Error(`${label}: enum field '${name}' lists a duplicate value.`);
    }
  } else if (record.values !== undefined) {
    throw new Error(`${label}: only an enum field may declare values, but '${name}' is '${String(type)}'.`);
  }
  if (record.optional !== undefined && typeof record.optional !== "boolean") {
    throw new Error(`${label}: field '${name}' has a non-boolean optional flag.`);
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    throw new Error(`${label}: field '${name}' has a non-string description.`);
  }
  if (record.separator !== undefined) {
    if (type !== "lines") {
      throw new Error(`${label}: only a lines field may declare a separator, but '${name}' is '${String(type)}'.`);
    }
    if (typeof record.separator !== "string") {
      throw new Error(`${label}: field '${name}' has a non-string separator.`);
    }
  }
  return {
    name,
    type,
    description: (record.description ?? "").trim(),
    optional: record.optional === true,
    ...(values ? { values } : {}),
    ...(typeof record.separator === "string" ? { separator: record.separator } : {})
  };
}

function validateBody(fields: readonly TemplateFieldSpec[], body: string, label: string): void {
  const declared = new Map(fields.map((field) => [field.name, field]));
  const used = new Set<string>();
  for (const [index, line] of body.split("\n").entries()) {
    const names = placeholders(line);
    if (!names.length) continue;
    for (const name of names) {
      if (!declared.has(name)) {
        throw new Error(`${label}: line ${index + 1} uses '{{${name}}}', which '${TEMPLATE_KEY}' does not declare.`);
      }
      used.add(name);
    }
    if (names.filter((name) => declared.get(name)!.type === "lines").length > 1) {
      throw new Error(`${label}: line ${index + 1} places more than one 'lines' field; render them on separate lines.`);
    }
  }
  const unused = fields.filter((field) => !used.has(field.name)).map((field) => `'${field.name}'`);
  if (unused.length) {
    throw new Error(`${label}: ${unused.join(", ")} declared under '${TEMPLATE_KEY}' but never used in the template body.`);
  }
}

export function parseTemplate(source: string, label: string): TemplateSpec {
  const front = FRONT_MATTER.exec(source);
  if (!front) {
    throw new Error(`${label}: a Dext template must start with YAML front matter declaring '${TEMPLATE_KEY}'.`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(front[1]!);
  } catch (error) {
    throw new Error(`${label}: front matter is not valid YAML: ${message(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: front matter must be a mapping containing '${TEMPLATE_KEY}'.`);
  }
  const declared = (parsed as Record<string, unknown>)[TEMPLATE_KEY];
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    throw new Error(`${label}: '${TEMPLATE_KEY}' must be a mapping of field names.`);
  }
  const fields: TemplateFieldSpec[] = [];
  let format: TemplateFormat | undefined;
  for (const [name, raw] of Object.entries(declared)) {
    // `format` is the template's required syntax option, so it is reserved: a
    // field cannot take its name, because a template that hid the format in a
    // field would leave Dext unable to check what the render must parse as.
    if (name === "format") {
      const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!TEMPLATE_FORMATS.includes(value as TemplateFormat)) {
        throw new Error(`${label}: 'format' must be declared as one of ${TEMPLATE_FORMATS.join(", ")}; it is a template option, so no field may be named 'format'.`);
      }
      format = value as TemplateFormat;
      continue;
    }
    if (!FIELD_NAME.test(name)) {
      throw new Error(`${label}: field name '${name}' must start with a letter or underscore and contain only letters, digits, '_' or '-'.`);
    }
    fields.push(parseField(name, raw, label));
  }
  if (!format) {
    throw new Error(`${label}: '${TEMPLATE_KEY}' must declare 'format' (${TEMPLATE_FORMATS.join(", ")}).`);
  }
  if (!fields.length) throw new Error(`${label}: '${TEMPLATE_KEY}' must declare at least one field.`);
  const body = source.slice(front[0].length).replace(/\r\n/g, "\n");
  if (!body.trim()) throw new Error(`${label}: the template body is empty.`);
  validateBody(fields, body, label);
  return { label, format, fields, body };
}

/** The structured-output contract handed to the CLI and to zod. Preset fields
 * are excluded so the model is never asked for a value Dext already owns.
 *
 * The object is deliberately not strict: a provider that echoes a preset field
 * back (it still saw the field name in the request payload) must not fail an
 * otherwise complete render. Undeclared keys are dropped, and a missing or
 * misspelled required field still fails as it should.
 *
 * For a parsed format the render itself is part of the contract: the values are
 * accepted only if they render to a valid document, and the parse error is what
 * the bounded repair is asked to fix. `z.toJSONSchema` ignores the refinement,
 * so the provider still receives the plain field schema. */
export function templateOutputSchema(spec: TemplateSpec, preset: TemplatePreset = { values: {}, names: new Set() }): ZodType {
  const shape: Record<string, ZodType> = { kind: z.literal("template") };
  for (const field of spec.fields) {
    if (preset.names.has(field.name)) continue;
    let schema: ZodType = field.type === "enum"
      ? z.enum(field.values as [string, ...string[]])
      : z.string();
    if (field.description) schema = schema.describe(field.description);
    if (field.optional) schema = schema.optional();
    shape[field.name] = schema;
  }
  const schema = z.object(shape);
  if (spec.format === "markdown" || spec.format === "text") return schema;
  return schema.superRefine((value, ctx) => {
    const error = renderedFormatError(spec, templateValues(spec, value, preset.values));
    if (error) ctx.addIssue({ code: "custom", message: error });
  });
}

export interface TemplatePreset {
  values: Record<string, string>;
  names: ReadonlySet<string>;
}

/** Validates the caller-supplied `values` argument against the template. */
export function templatePreset(spec: TemplateSpec, raw: unknown): TemplatePreset {
  const values: Record<string, string> = {};
  if (raw === undefined) return { values, names: new Set() };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("template values must be an object keyed by field name.");
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = spec.fields.find((candidate) => candidate.name === name);
    if (!field) throw new Error(`template values contains '${name}', which '${spec.label}' does not declare.`);
    if (value === null) {
      values[name] = "";
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`template value '${name}' must be text.`);
    }
    const text = typeof value === "string" ? value : String(value);
    if (field.type === "enum" && text.trim() && !field.values!.includes(text.trim())) {
      throw new Error(`template value '${name}' must be one of ${field.values!.map((item) => `'${item}'`).join(", ")}.`);
    }
    values[name] = text;
  }
  return { values, names: new Set(Object.keys(values)) };
}

function headingLevel(line: string): number {
  const match = /^(#{1,6})\s/.exec(line);
  return match ? match[1]!.length : 0;
}

/** Lines inside a fenced code block are content, not structure: a `#` comment in
 * a sample must not be treated as a heading, and its blank lines must survive. */
function fencedLines(lines: readonly string[]): boolean[] {
  const fenced: boolean[] = [];
  let open = false;
  for (const line of lines) {
    const marker = /^\s*(```|~~~)/.test(line);
    fenced.push(open);
    if (marker) open = !open;
  }
  return fenced;
}

/** Removes one heading block whose body has no content left. */
function dropEmptySection(lines: readonly string[], fenced: readonly boolean[]): string[] | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    const level = headingLevel(lines[index]!);
    if (!level) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (fenced[next]) continue;
      const nextLevel = headingLevel(lines[next]!);
      if (nextLevel && nextLevel <= level) {
        end = next;
        break;
      }
    }
    if (lines.slice(index + 1, end).every((line) => line.trim() === "")) {
      return [...lines.slice(0, index), ...lines.slice(end)];
    }
  }
  return undefined;
}

function collapseBlankLines(lines: readonly string[], fenced: readonly boolean[]): string[] {
  const result: string[] = [];
  let blank = 0;
  for (const [index, line] of lines.entries()) {
    if (!fenced[index] && line.trim() === "") {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    result.push(line);
  }
  return result;
}

function trimBlankEdges(lines: readonly string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length && trimmed[0]!.trim() === "") trimmed.shift();
  while (trimmed.length && trimmed[trimmed.length - 1]!.trim() === "") trimmed.pop();
  return trimmed;
}

function finalize(lines: readonly string[], format: TemplateFormat): string {
  let trimmed = trimBlankEdges(lines);
  // Only Markdown has structural rules: a heading whose section ended up empty
  // is dropped with it, and consecutive blank lines collapse. Every other format
  // is rendered literally, because its syntax belongs to the template.
  if (format !== "markdown") return `${trimmed.join("\n")}\n`;
  for (;;) {
    const fenced = fencedLines(trimmed);
    const dropped = dropEmptySection(trimmed, fenced);
    if (!dropped) break;
    trimmed = trimBlankEdges(dropped);
  }
  const collapsed = collapseBlankLines(trimmed, fencedLines(trimmed));
  return collapsed.map((line) => line.replace(/[ \t]+$/, "")).join("\n") + "\n";
}

/** The error message when `text` is not valid in `format`. `markdown` and
 * `text` have no syntax to check, so they never fail. */
export function templateFormatError(format: TemplateFormat, text: string): string | undefined {
  if (format === "markdown" || format === "text") return undefined;
  try {
    if (format === "json") JSON.parse(text);
    else if (format === "toml") parseTomlSource(text);
    else parseYaml(text);
  } catch (error) {
    return `Rendered ${format.toUpperCase()} is invalid: ${message(error)}`;
  }
  return undefined;
}

function renderedFormatError(spec: TemplateSpec, values: Readonly<Record<string, string | undefined>>): string | undefined {
  return templateFormatError(spec.format, renderTemplateText(spec, values));
}

/** Renders the template body. Structure comes from the template, never from the
 * model: an absent optional field removes its placeholder line, and — in a
 * Markdown template — a section left with no content removes its heading too. */
export function renderTemplateText(spec: TemplateSpec, values: Readonly<Record<string, string | undefined>>): string {
  const lines: string[] = [];
  for (const line of spec.body.split("\n")) {
    const names = placeholders(line);
    if (!names.length) {
      lines.push(line);
      continue;
    }
    const listField = spec.fields.find((field) => field.type === "lines" && names.includes(field.name));
    if (listField) {
      const value = values[listField.name];
      if (!hasText(value)) continue;
      const items = listItems(value!, spec.format === "markdown");
      if (!items.length) continue;
      // One item repeats the placeholder's line, so a JSON or TOML array gets
      // its commas from the field's separator rather than from a trailing one
      // the last item would also carry.
      const rendered = items.map((item) => substitute(line, (name) => (name === listField.name ? item : values[name])));
      lines.push(...rendered.join(listField.separator ?? "\n").split("\n"));
      continue;
    }
    const rendered = substitute(line, (name) => values[name]);
    if (stripPlaceholders(line).trim() === "" && rendered.trim() === "") continue;
    lines.push(rendered);
  }
  return finalize(lines, spec.format);
}

/** What the template's format asks of the model beyond the field list: that a
 * value is inserted verbatim where its placeholder sits, and that a parsed
 * format is checked after rendering. */
export function templateInstruction(spec: TemplateSpec): string {
  const upper = spec.format.toUpperCase();
  const structure = "The structure around each field comes from the template, never from your answer: never write the file's headings, keys, list markers or section order yourself.";
  if (spec.format === "markdown" || spec.format === "text") {
    return `Dext renders your field values into '${spec.label}' as ${upper}. ${structure}`;
  }
  return `Dext renders your field values into '${spec.label}' as ${upper}. Each value is inserted verbatim where its placeholder sits, so quote and punctuate it exactly as the field's description requires. ${structure} The rendered file must parse as valid ${upper}: an answer that does not is rejected, and you are asked once more with the parse error.`;
}

/** Field values for rendering: the validated model output, with Dext-owned
 * preset values taking precedence. */
export function templateValues(
  spec: TemplateSpec,
  result: Readonly<Record<string, unknown>>,
  preset: Readonly<Record<string, string>>
): Record<string, string> {
  const values: Record<string, string> = { ...preset };
  for (const field of spec.fields) {
    if (Object.hasOwn(preset, field.name)) continue;
    const value = result[field.name];
    if (typeof value === "string") values[field.name] = value;
  }
  return values;
}
