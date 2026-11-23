/**
 * Public result shapes exposed by the Dext workflow language.  This is kept
 * independent of the runtime TypeScript interfaces so editor features can
 * describe the language contract without exposing host-only fields.
 */
import { BUILTIN_METHODS } from "./builtins.js";
import { formatFieldType } from "./methodSignature.js";
import {
  UI_VIEW_NODE_TYPES, UI_VIEW_LAYOUT_CHILD_TYPES, UI_VIEW_LINE_CHILD_TYPES, UI_VIEW_ICONS,
  UI_VIEW_GAPS, UI_VIEW_LAYOUT_DEFAULTS, UI_VIEW_STATUSES, UI_VIEW_TONES, UI_VIEW_MAX_DEPTH,
  UI_VIEW_MAX_NODES, UI_VIEW_MAX_BYTES
} from "../../../shared/contracts/uiView.js";
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
  alias?: string;
}

/** These names are reserved for future consumers and never form part of ui.Node. */
export const RESERVED_UI_TYPE_DEFINITIONS = [
  "Table", "Progress", "Tooltip", "Popover", "Drawer", "Toast", "Breadcrumb",
  "Slider", "Switch", "Avatar", "Skeleton", "Kbd"
].map((name) => ({ name, status: "reserved" as const }));

const literals = (values: readonly string[]): string => values.map((value) => JSON.stringify(value)).join(" | ");
type DisplayNodeName = typeof UI_VIEW_NODE_TYPES[number];
const uiNodeAlias = (types: readonly DisplayNodeName[]): string => types.map((type) => `ui.${type}`).join(" | ");
const layoutChildrenField = { name: "children", type: "list[ui.LayoutChild]", description: "Display children in declaration order. An empty array is allowed." };
const displayText = { name: "text", type: "string" };
const displayTone = { name: "tone", type: literals(UI_VIEW_TONES), optional: true };
const displayStatus = { name: "status", type: literals(UI_VIEW_STATUSES), optional: true };
const displayNodeDetails: Record<DisplayNodeName, Omit<BuiltinTypeDefinition, "name">> = {
  Stack: { description: "A vertical sequence of display nodes.", fields: [
    { name: "gap", type: "ui.Gap", optional: true, description: `Defaults to "${UI_VIEW_LAYOUT_DEFAULTS.Stack.gap}".` },
    layoutChildrenField
  ] },
  Inline: { description: "A horizontal sequence that wraps by default.", fields: [
    { name: "gap", type: "ui.Gap", optional: true, description: `Defaults to "${UI_VIEW_LAYOUT_DEFAULTS.Inline.gap}".` },
    { name: "wrap", type: "boolean", optional: true, description: `Defaults to ${UI_VIEW_LAYOUT_DEFAULTS.Inline.wrap}.` },
    layoutChildrenField
  ] },
  Section: { description: "A titled section. The first section heading is h3 and nested sections increment to h6.", fields: [
    { name: "title", type: "string", description: "A non-empty visible heading." },
    { name: "description", type: "string", optional: true, description: "Plain text below the heading. Omitted by default." },
    layoutChildrenField
  ] },
  Empty: { description: "An explicitly empty state.", fields: [{ ...displayText, description: "A non-empty visible message." }] },
  Trace: { description: "A list of process rows.", fields: [
    { name: "ordered", type: "boolean", optional: true, description: "Defaults to false." },
    { name: "children", type: "list[ui.TraceLine]", description: "Only TraceLine nodes are allowed directly inside a Trace." }
  ] },
  TraceLine: { description: "A process row. A standalone root row is supported for compatibility.", fields: [
    { ...displayStatus, description: "Omitted by default." },
    { ...displayTone, description: 'Defaults to "normal".' },
    { name: "children", type: "list[ui.TraceLineChild]" }
  ] },
  TraceIcon: { description: "A decorative icon for a process row.", fields: [{ name: "icon", type: literals(UI_VIEW_ICONS) }] },
  TraceTitle: { description: "The title of a process row.", fields: [displayText] },
  TraceDescription: { description: "A description for a process row.", fields: [displayText, { ...displayTone, description: 'Defaults to "normal".' }] },
  Text: { description: "A plain-text node.", fields: [displayText, { ...displayTone, description: 'Defaults to "normal".' }] },
  Markdown: { description: "Read-only Markdown with inert links, images and raw HTML.", fields: [{ name: "source", type: "string" }] },
  Code: { description: "Inline code with literal text.", fields: [displayText] },
  CodeBlock: { description: "Preformatted code with literal text. Script output keeps its copy control disabled.", fields: [{ name: "code", type: "string" }] },
  Separator: { description: "A thematic break with no additional fields.", fields: [] },
  Badge: { description: "A visible label for a task or general feedback.", fields: [displayText,
    { ...displayStatus, description: "Task status. Omitted by default." },
    { ...displayTone, description: "When omitted, the task status keeps its original appearance." }
  ] },
  Spinner: { description: "A read-only busy indicator.", fields: [{ name: "label", type: "string", description: "A non-empty visible name." }] },
  Alert: { description: "A static feedback message.", fields: [displayText, { ...displayTone, description: 'Defaults to "info".' }] }
};
const displayNodeTypes: BuiltinTypeDefinition[] = UI_VIEW_NODE_TYPES.map((type) => ({
  name: `ui.${type}`,
  description: displayNodeDetails[type].description,
  fields: [{ name: "type", type: JSON.stringify(type) }, ...displayNodeDetails[type].fields]
}));

const staticTypes: readonly BuiltinTypeDefinition[] = [
  { name: "AskResult", description: "Text returned by Ask.", fields: [
    { name: "kind", type: '"ask"' }, { name: "text", type: "string" }
  ] },
  { name: "PlanResult", description: "Text returned by Plan and its optional saved-plan path; planPath is an absolute path under global storage and a plan-directory relative path under workspace storage.", fields: [
    { name: "kind", type: '"plan"' }, { name: "text", type: "string" }, { name: "planPath", type: "string", optional: true },
    { name: "executePlan", type: "boolean", optional: true }, { name: "planOutcome", type: "object", optional: true }
  ] },
  { name: "SkillResult", description: "Text returned after executing a skill.", fields: [
    { name: "kind", type: '"skill"' }, { name: "text", type: "string" }
  ] },
  { name: "AgentResult", description: "Result of a continuous Agent task; preview-only edits may include a patch, while patch=false returns text only.", fields: [
    { name: "kind", type: '"agent"' }, { name: "text", type: "string" }, { name: "summary", type: "string", optional: true },
    { name: "patch", type: "PatchResult", optional: true }, { name: "files", type: "CodeRef[]", optional: true }
  ] },
  { name: "TemplateResult", description: "Text rendered by Dext from a template; the model supplied only the field values. Nothing is written, so the caller saves it with fs.writeFile.", fields: [
    { name: "kind", type: '"template"' }, { name: "text", type: "string" }
  ] },
  { name: "ApplyResult", description: "Outcome of applying a patch.", fields: [
    { name: "kind", type: '"apply"' }, { name: "status", type: '"applied" | "unchanged" | "conflict"' }, { name: "summary", type: "string" }, { name: "files", type: "CodeRef[]" }
  ] },
  { name: "TerminalResult", description: "Captured execution of a terminal command.", fields: [
    { name: "kind", type: '"terminal"' }, { name: "status", type: '"succeeded" | "failed" | "timed_out"' }, { name: "command", type: "string" }, { name: "cwd", type: "string" },
    { name: "exit_code", type: "number" }, { name: "stdout", type: "string" }, { name: "stderr", type: "string" }, { name: "duration_ms", type: "number" }
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
  { name: "ui.Node", description: `A read-only display node accepted by ui.render. A tree accepts up to ${UI_VIEW_MAX_DEPTH} levels, ${UI_VIEW_MAX_NODES} nodes and ${UI_VIEW_MAX_BYTES} UTF-8 bytes. Validation reports the location of an invalid node, such as nodes[0].children[1].`,
    fields: [], alias: uiNodeAlias(UI_VIEW_NODE_TYPES) },
  { name: "ui.LayoutChild", description: "A display node allowed inside a Stack, Inline or Section.",
    fields: [], alias: uiNodeAlias(UI_VIEW_LAYOUT_CHILD_TYPES) },
  { name: "ui.Gap", description: "Spacing between layout children.", fields: [], alias: literals(UI_VIEW_GAPS) },
  ...displayNodeTypes,
  { name: "ui.TraceLineChild", description: "A read-only node that can appear inside a trace line.",
    fields: [], alias: uiNodeAlias(UI_VIEW_LINE_CHILD_TYPES) },
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
  { name: "agent.PiModelOptions", description: "Pi per-call model selection; reasoning levels come from the selected model.", fields: [
    { name: "model", type: "string", description: "Pi provider/modelId." }, { name: "reasoning", type: "string", optional: true }
  ] },
  { name: "agent.ModelOptions", description: "Codex per-call model selection options.", fields: [
    { name: "model", type: "string" }, { name: "reasoning", type: '"low" | "medium" | "high" | "xhigh" | "max" | "ultra"', optional: true }, { name: "speed", type: '"standard" | "fast"', optional: true }
  ] }
];

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

const types: readonly BuiltinTypeDefinition[] = [...staticTypes, ...declaredOutputTypes, {
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

