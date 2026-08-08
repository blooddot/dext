import type { InvocationAst } from "./types.js";

export function compileChat(message: string): InvocationAst {
  return {
    kind: "invocation",
    method: "core.chat.respond",
    arguments: [{ name: "message", value: message }],
    source: "chat"
  };
}
