import type { CallableDefinition } from "./types.js";

const CONTEXTS = ["selection", "activeFile", "file", "symbol"] as const;

export const BUILTIN_METHODS: readonly CallableDefinition[] = [
  {
    id: "ask",
    title: "Ask",
    description: "Hold a read-only conversation about a string input with optional inline Dext references.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "input", type: "string", required: true, description: "Question or analysis request. Use @workspace/path tokens for attached code references." },
      { name: "workspace", type: "dir", description: "Optional workspace directory; defaults to the current project root." }
    ],
    output: { kind: "chat" },
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
    description: "Render a typed text value in Dext Output.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "text", type: "string", required: true, description: "Text rendered in Dext Output." },
      { name: "label", type: "string", description: "Optional output label." }
    ],
    output: { kind: "print" },
    executor: { kind: "deterministic", handler: "printText" }
  },
  {
    id: "terminal",
    title: "Run Terminal Command",
    description: "Run a confirmed command in a trusted local workspace and return captured output.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "command", type: "string", required: true, description: "Command passed to the platform default shell." },
      { name: "cwd", type: "string", default: ".", description: "Workspace-contained working directory." },
      { name: "timeout_ms", type: "number", default: 120000, description: "Timeout in milliseconds, up to 600000." }
    ],
    output: { kind: "terminal" },
    executor: { kind: "deterministic", handler: "terminalRun" }
  },
  {
    id: "ui.choose",
    title: "Choose",
    description: "Ask the user to choose one or more semantic options. Dext owns the UI presentation and resumes the current task after the answer.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "label", type: "string", required: true, description: "Question or decision label." },
      { name: "options", type: "string", required: true, multiple: true, description: "Available option labels." },
      { name: "multiple", type: "boolean", default: false, description: "Allow more than one selection." },
      { name: "allow_custom", type: "boolean", default: false, description: "Offer a custom text alternative." },
      { name: "custom_placeholder", type: "string", description: "Hint for the custom text field." }
    ],
    output: { kind: "ui" },
    executor: { kind: "deterministic", handler: "uiChoose" }
  },
  {
    id: "ui.confirm",
    title: "Confirm",
    description: "Ask the user to confirm or cancel an operation, then resume the current task.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "message", type: "string", required: true, description: "Confirmation message." },
      { name: "confirm_label", type: "string", default: "Continue", description: "Confirm action label." },
      { name: "cancel_label", type: "string", default: "Cancel", description: "Cancel action label." }
    ],
    output: { kind: "ui" },
    executor: { kind: "deterministic", handler: "uiConfirm" }
  },
  {
    id: "ui.input",
    title: "Input",
    description: "Ask the user for a text value, then resume the current task.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "label", type: "string", required: true, description: "Input label." },
      { name: "placeholder", type: "string", description: "Input hint." },
      { name: "multiline", type: "boolean", default: false, description: "Request multiline text when the host supports it." }
    ],
    output: { kind: "ui" },
    executor: { kind: "deterministic", handler: "uiInput" }
  },
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
    output: { kind: "chat" },
    executor: { kind: "deterministic", handler: "runSkill" }
  },
  {
    id: "mcp",
    title: "Call MCP Tool",
    description: "Call an explicitly registered MCP tool by its configured full name with a typed dictionary input. Dext rejects unknown tools before transport is opened.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "tool", type: "string", required: true, description: "Configured full tool name in server.tool form." },
      { name: "input", type: "object", required: true, default: {}, description: "Dictionary supplied to the MCP tool." }
    ],
    output: { kind: "mcpRaw" },
    executor: { kind: "deterministic", handler: "mcpCall" }
  }
];
