import type { CallableDefinition } from "./types.js";

const CONTEXTS = ["selection", "activeFile", "file", "symbol"] as const;

export const BUILTIN_METHODS: readonly CallableDefinition[] = [
  {
    id: "chat",
    title: "Chat",
    description: "Return a typed response for an explicit natural-language instruction.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "message", type: "string", required: true, description: "Instruction for the model." },
      { name: "context", type: "context", multiple: true, description: "Optional immutable code references." }
    ],
    output: { kind: "chat" },
    context: [...CONTEXTS],
    executor: { kind: "deterministic", handler: "chatRespond" }
  },
  {
    id: "code.explain",
    title: "Explain Code",
    description: "Explain the supplied code or prior Dext result according to the requested focus.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "target", type: "context", accepts: ["result"], required: true, multiple: true, description: "Code or Dext result to explain." },
      { name: "instruction", type: "string", description: "Explanation focus." }
    ],
    output: { kind: "explain" },
    context: [...CONTEXTS],
    executor: { kind: "deterministic", handler: "explainCode" }
  },
  {
    id: "code.edit",
    title: "Edit Code",
    description: "Produce a concrete, preview-only code edit with exact before and after content for every changed file.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "target", type: "context", required: true, multiple: true, description: "Code to edit." },
      { name: "instruction", type: "string", required: true, description: "Requested edit." }
    ],
    output: {
      kind: "edit",
      description: "A concrete edit proposal. Each patch change keeps the exact original content in before and the complete proposed replacement in after."
    },
    context: [...CONTEXTS],
    executor: { kind: "deterministic", handler: "editCode" }
  },
  {
    id: "code.review",
    title: "Review Code",
    description: "Resolve code and produce a structured review result.",
    kind: "command",
    version: "1.0.0",
    input: [
      { name: "target", type: "context", accepts: ["result"], required: true, multiple: true, description: "Code or Dext result to review." },
      { name: "instruction", type: "string", description: "Review focus." }
    ],
    output: { kind: "review" },
    context: [...CONTEXTS],
    executor: { kind: "deterministic", handler: "reviewCode" }
  },
  {
    id: "code.apply",
    title: "Apply Patch",
    description: "Validate and apply a typed edit result to the current trusted workspace.",
    kind: "command",
    version: "1.0.0",
    input: [{ name: "result", type: "result", required: true, description: "A Dext result containing an applicable patch, usually an EditResult." }],
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
    id: "terminal.run",
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
  }
];
