import type { CallableDefinition, FieldDefinition } from "./types.js";
import { builtinCliFields, CLI_BUILTIN_IDS } from "./builtinCli.js";
import { NODE_BUILTIN_METHODS } from "./generated/nodeBuiltinCatalog.js";

const CONTEXTS = ["selection", "activeFile", "file", "symbol"] as const;

const METHODS: readonly CallableDefinition[] = [
  {
    id: "ask",
    title: "Ask",
    description: "Hold a read-only conversation about a string input with optional inline Dext references.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "input", type: "string", required: true, description: "Question or analysis request. Use @workspace/path tokens for attached code references." },
      { name: "skills", type: "string", multiple: true, internal: true, description: "Optional Dext skill identifiers loaded only for this Ask call." },
      { name: "rules", type: "string", multiple: true, internal: true, description: "Optional .dext/rules-relative files loaded only for this Ask call." },
      { name: "workspace", type: "dir", description: "Optional workspace directory; defaults to the current project root." }
    ],
    output: { kind: "ask" },
    context: [...CONTEXTS],
    executor: { kind: "deterministic", handler: "askRespond" }
  },
  {
    id: "plan",
    title: "Plan",
    description: "Generate and execute an implementation plan with the selected Plan write scope.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "input", type: "string", required: true, description: "Goal to plan for. Use @workspace/path tokens for attached code references." },
      { name: "skills", type: "string", multiple: true, internal: true, description: "Optional Dext skill identifiers loaded only for this Plan call." },
      { name: "rules", type: "string", multiple: true, internal: true, description: "Optional .dext/rules-relative files loaded only for this Plan call." },
      { name: "workspace", type: "dir", description: "Optional workspace directory; defaults to the current project root." },
    ],
    output: { kind: "plan" },
    context: [...CONTEXTS],
    executor: { kind: "deterministic", handler: "askRespond" }
  },
  {
    id: "agent",
    title: "Agent",
    description: "Run a continuous task from a string input with optional inline Dext references. By default, the selected Agent may modify a trusted workspace.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "input", type: "string", required: true, description: "Task request. Use @workspace/path tokens for attached code references." },
      { name: "apply", type: "boolean", default: true, description: "Allow trusted workspace changes. Set false to require a preview-only patch." },
      { name: "skills", type: "string", multiple: true, internal: true, description: "Optional Dext skill identifiers loaded only for this Agent call." },
      { name: "rules", type: "string", multiple: true, internal: true, description: "Optional .dext/rules-relative files loaded only for this Agent call." },
      { name: "workspace", type: "dir", description: "Optional workspace directory; defaults to the current project root." }
    ],
    output: {
      kind: "agent",
      description: "Continuous Agent task result. Preview-only edits include an applicable patch."
    },
    context: [...CONTEXTS],
    executor: { kind: "deterministic", handler: "agentRespond" }
  },
  {
    id: "apply",
    title: "Apply Patch",
    description: "Validate and apply a typed edit result to the current trusted workspace.",
    kind: "command",
    version: "1.0.0",
    input: [{ name: "result", type: "result", required: true, description: "A Dext result containing an applicable patch, usually an AgentResult." }],
    output: { kind: "apply" },
    executor: { kind: "deterministic", handler: "applyPatch" }
  },
  {
    id: "print",
    title: "Print",
    description: "Render a value in Dext Output. Primitive values are shown as text; objects, lists, and API results are rendered as JSON.",
    kind: "command",
    version: "1.0.0",
    input: [
      {
        name: "text",
        type: "string",
        accepts: ["number", "boolean", "object", "list", "result", "context", "dir"],
        required: true,
        description: "Value rendered in Dext Output. Objects, lists, and API results are rendered as JSON."
      },
      { name: "label", type: "string", description: "Optional output label." }
    ],
    output: { kind: "print" },
    executor: { kind: "deterministic", handler: "printText" }
  },
  {
    id: "terminal",
    title: "Run Terminal Command",
    description: "Run a command in a trusted local workspace and return captured output. The command runs without a confirmation prompt, so a workflow decides what is safe to run.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "command", type: "string", required: true, description: "Command passed to the platform default shell." },
      { name: "cwd", type: "string", default: ".", description: "Workspace-contained working directory." },
      { name: "env", type: "object", default: {}, description: "Optional string environment variables available to the command." },
      { name: "timeout_ms", type: "number", default: 120000, description: "Timeout in milliseconds, up to 600000." }
    ],
    output: { kind: "terminal" },
    executor: { kind: "deterministic", handler: "terminalRun" }
  },
  ...(["select", "radio", "checkbox", "input", "confirm", "alert", "form"] as const).map(uiDefinition),
  {
    id: "skill",
    title: "Run Skill",
    description: "Load and execute a standard SKILL.md from the configured project skill directories.",
    kind: "skill",
    version: "1.0.0",
    input: [
      { name: "skill", type: "string", required: true, description: "Discovered skill identifier." },
      { name: "input", type: "string", required: true, description: "Direct task input for the skill." },
      { name: "workspace", type: "dir", description: "Optional workspace directory; defaults to the current project root." }
    ],
    output: { kind: "skill" },
    executor: { kind: "deterministic", handler: "runSkill" }
  }
];

export const BUILTIN_METHODS: readonly CallableDefinition[] = [...METHODS, ...NODE_BUILTIN_METHODS].map((method) =>
  CLI_BUILTIN_IDS.has(method.id) ? { ...method, input: [...method.input, ...builtinCliFields()] } : method
);

function uiDefinition(action: "select" | "radio" | "checkbox" | "input" | "confirm" | "alert" | "form"): CallableDefinition {
  const input: CallableDefinition["input"] = [];
  const field = (name: string, type: "string" | "boolean", defaultValue?: string | boolean): void => {
    input.push({ name, type, ...(defaultValue === undefined ? { required: true } : { default: defaultValue }) });
  };
  if (["select", "radio", "checkbox", "input"].includes(action)) field("label", "string");
  if (["select", "radio", "checkbox"].includes(action)) {
    input.push({ name: "options", type: "list", items: { name: "option", type: "string" }, required: true, description: "Nonempty list of option labels." });
    if (action === "select") { field("multiple", "boolean", false); field("placeholder", "string", "Select…"); }
    else { field("allow_custom", "boolean", false); field("custom_placeholder", "string", ""); }
  }
  if (action === "input") { field("placeholder", "string", ""); field("multiline", "boolean", false); }
  if (action === "confirm" || action === "alert") field("message", "string");
  if (action === "confirm") {
    field("confirm_label", "string", "Continue"); field("cancel_label", "string", "Cancel");
    input.push({ name: "on_cancel", type: "enum", values: ["return", "abort"], default: "return", description: "Whether cancellation returns a result or aborts the current workflow." });
  }
  if (action === "alert") field("acknowledge_label", "string", "OK");
  if (action === "form") {
    field("title", "string");
    input.push({ name: "fields", type: "list", required: true, items: uiFieldDefinition(), description: "Declarative select, radio, checkbox or input fields." });
    field("description", "string", ""); field("submit_label", "string", "Submit");
    field("cancel_label", "string", "Cancel"); field("show_cancel", "boolean", true);
    input.push({ name: "on_cancel", type: "enum", values: ["return", "abort"], default: "return", description: "Whether cancellation returns a result or aborts the current workflow." });
  }
  input.push({ name: "presentation", type: "enum", values: ["inline", "dialog"], default: action === "form" ? "inline" : "dialog", description: "Interaction container." });
  return { id: `ui.${action}`, title: action, description: `Request ${action} interaction and wait for the user's response.`,
    kind: "command", version: "1.0.0", input, output: { kind: "ui", resultType: `Ui${action[0]!.toUpperCase()}${action.slice(1)}Result`, fields: uiOutputFields(action) }, executor: { kind: "deterministic", handler: `ui${action[0]!.toUpperCase()}${action.slice(1)}` } };
}

function uiFieldDefinition(): FieldDefinition {
  const common: FieldDefinition[] = [
    { name: "id", type: "string", required: true },
    { name: "type", type: "enum", values: ["select", "radio", "checkbox", "input"], required: true },
    { name: "label", type: "string", required: true },
    { name: "description", type: "string" }, { name: "required", type: "boolean", default: true }
  ];
  const optionFields: FieldDefinition[] = [
    { name: "options", type: "list", items: uiOptionDefinition(), required: true },
    { name: "default", type: "list", items: { name: "option", type: "string" } }
  ];
  return {
    name: "field", type: "object", shapeType: "ui.Field", properties: common,
    discriminator: {
      name: "type",
      variants: [
        { value: "select", properties: [...optionFields, { name: "multiple", type: "boolean", default: false }, { name: "placeholder", type: "string" }] },
        { value: "radio", properties: [...optionFields, { name: "allow_custom", type: "boolean", default: false }, { name: "custom_placeholder", type: "string" }] },
        { value: "checkbox", properties: [...optionFields, { name: "allow_custom", type: "boolean", default: false }, { name: "custom_placeholder", type: "string" }] },
        { value: "input", properties: [{ name: "default", type: "string" }, { name: "placeholder", type: "string" }, { name: "multiline", type: "boolean", default: false }] }
      ]
    }
  };
}

function uiOptionDefinition(): FieldDefinition {
  return {
    name: "option", type: "string", accepts: ["object"], shapeType: "ui.Option",
    properties: [
      { name: "value", type: "string", required: true },
      { name: "label", type: "string", required: true },
      { name: "description", type: "string" }
    ]
  };
}

export function uiOutputFields(action: string): CallableDefinition["input"] {
  const fields: CallableDefinition["input"] = [{ name: "kind", type: "enum", values: ["ui"] }, { name: "type", type: "enum", values: [action] }];
  if (["select", "radio", "checkbox"].includes(action)) fields.push({ name: "selected", type: "list", items: { name: "option", type: "string" } });
  if (action === "radio" || action === "checkbox") fields.push({ name: "custom", type: "string" });
  if (action === "input") fields.push({ name: "value", type: "string" });
  if (action === "confirm") fields.push({ name: "confirmed", type: "boolean" });
  if (action === "alert") fields.push({ name: "status", type: "enum", values: ["acknowledged", "dismissed"] });
  if (action === "form") fields.push({ name: "status", type: "enum", values: ["submitted", "cancelled"] },
    { name: "answers", type: "object", properties: [
      { name: "type", type: "enum", values: ["select", "radio", "checkbox", "input"] },
      { name: "selected", type: "list", items: { name: "option", type: "string" } }, { name: "custom", type: "string" }, { name: "value", type: "string" }
    ] });
  return fields;
}
