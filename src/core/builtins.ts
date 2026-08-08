import type { CallableDefinition } from "./types.js";

export const BUILTIN_METHODS: readonly CallableDefinition[] = [
  {
    id: "core.chat.respond",
    title: "Respond",
    description: "Return a deterministic structured response for chat input.",
    kind: "command",
    version: "1.0.0",
    input: [
      {
        name: "message",
        type: "string",
        required: true,
        description: "The user's message."
      }
    ],
    output: { kind: "text" },
    executor: { kind: "deterministic", handler: "chatRespond" }
  },
  {
    id: "core.code.review",
    title: "Review Code",
    description: "Inspect referenced code and produce a structured review shell.",
    kind: "command",
    version: "1.0.0",
    input: [
      {
        name: "target",
        type: "context",
        required: true,
        description: "Code to review."
      },
      {
        name: "focus",
        type: "enum",
        values: ["correctness", "maintainability", "security"],
        default: "correctness",
        description: "Review focus."
      }
    ],
    output: { kind: "review" },
    context: ["selection", "activeFile", "file", "symbol"],
    executor: { kind: "deterministic", handler: "reviewCode" }
  },
  {
    id: "core.context.snapshot",
    title: "Context Snapshot",
    description: "Resolve a code reference and return its immutable snapshot.",
    kind: "skill",
    version: "1.0.0",
    input: [
      {
        name: "target",
        type: "context",
        required: true,
        description: "Code reference to resolve."
      }
    ],
    output: { kind: "code" },
    context: ["selection", "activeFile", "file", "symbol"],
    executor: { kind: "deterministic", handler: "contextSnapshot" }
  }
];
