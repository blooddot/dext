import type { AgentTimeout } from "./agentTimeout.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

const CODEX_TOOL_TYPES = new Set(["command_execution", "mcp_tool_call", "dynamic_tool_call", "tool_call", "web_search", "file_change"]);

/** Read lifecycle events before presentation filters discard empty results or
 * collapse a message containing several concurrent tools. Unknown events do
 * not suspend the watchdog. */
export function trackCliToolActivity(provider: string, line: string, timeout: AgentTimeout): void {
  let event: Record<string, unknown> | undefined;
  try { event = record(JSON.parse(line)); } catch { return; }
  if (!event) return;
  if (provider === "codex") {
    const item = record(event.item);
    const id = item?.id ?? event.item_id;
    if (typeof id !== "string" || !id) return;
    if (event.type === "item.completed" || event.type === "item.failed") {
      timeout.toolFinished(id);
    } else if ((event.type === "item.started" || event.type === "item.updated")
      && typeof item?.type === "string" && CODEX_TOOL_TYPES.has(item.type)) {
      if (item.status === "completed" || item.status === "failed") timeout.toolFinished(id);
      else timeout.toolStarted(id);
    }
    return;
  }
  if (provider !== "claude") return;
  const stream = record(event.event);
  if (event.type === "stream_event" && stream?.type === "content_block_start") {
    const block = record(stream.content_block);
    if (block?.type === "tool_use" && typeof block.id === "string") timeout.toolStarted(block.id);
    return;
  }
  const message = record(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const raw of content) {
    const block = record(raw);
    if (event.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string") {
      timeout.toolStarted(block.id);
    } else if (event.type === "user" && block?.type === "tool_result" && typeof block.tool_use_id === "string") {
      timeout.toolFinished(block.tool_use_id);
    }
  }
}
