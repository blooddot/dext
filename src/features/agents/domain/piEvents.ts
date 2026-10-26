import { piObject, piText, type PiRecord } from "../contracts/pi.js";
import type { AgentStreamEvent, AgentTokenUsage } from "../../../shared/contracts/types.js";
import { normalizeAgentTodos } from "./agentTodoTracking.js";

type Totals = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
function totals(value: unknown): Totals | undefined {
  const raw = piObject(value);
  if ([raw.input, raw.output, raw.cacheRead, raw.cacheWrite, raw.totalTokens, raw.total].every((item) => count(item) === undefined)) return undefined;
  const input = count(raw.input) ?? 0, output = count(raw.output) ?? 0, cacheRead = count(raw.cacheRead) ?? 0, cacheWrite = count(raw.cacheWrite) ?? 0;
  return { input, output, cacheRead, cacheWrite, total: count(raw.totalTokens) ?? count(raw.total) ?? input + output + cacheRead + cacheWrite };
}
const contentText = (content: unknown, kind: string): string => Array.isArray(content) ? content.flatMap((raw) => {
  const item = piObject(raw); return item.type === kind && typeof item[kind] === "string" ? [item[kind]] : [];
}).join("\n") : "";

/** Per-Dext-turn accumulator. Emitted usage is always the complete latest turn snapshot. */
export class PiEvents {
  private sequence = 0;
  private current = "";
  private readonly blocks = new Map<string, string>();
  private readonly usages = new Map<string, Totals>();
  private readonly messageIds = new Map<string, string>();
  private baseline: Totals | undefined;
  private finalTotals?: Totals;
  private context: Pick<AgentTokenUsage, "contextTokens" | "contextWindowTokens"> = {};
  finalText = "";
  error: string | undefined;
  stopReason = "";
  constructor(private readonly prefix: string) {}
  setBaseline(stats: unknown): void { this.baseline = totals(piObject(stats).tokens); }
  setStats(stats: unknown): void {
    const raw = piObject(stats), after = totals(raw.tokens);
    if (after && this.baseline) {
      const before = this.baseline;
      const difference: Totals = { input: after.input - before.input, output: after.output - before.output,
        cacheRead: after.cacheRead - before.cacheRead, cacheWrite: after.cacheWrite - before.cacheWrite, total: after.total - before.total };
      if (Object.values(difference).every((value) => value >= 0) && difference.total >= this.messageTotals().total) this.finalTotals = difference;
    }
    const context = piObject(raw.contextUsage);
    this.context = { ...(count(context.tokens) !== undefined ? { contextTokens: count(context.tokens)! } : {}),
      ...(count(context.contextWindow) ? { contextWindowTokens: count(context.contextWindow)! } : {}) };
  }
  private messageTotals(): Totals {
    const result: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    for (const value of this.usages.values()) for (const key of Object.keys(result) as (keyof Totals)[]) result[key] += value[key];
    return result;
  }
  usage(): AgentTokenUsage | undefined {
    const value = this.finalTotals ?? (this.usages.size ? this.messageTotals() : undefined);
    if (!value && !Object.keys(this.context).length) return undefined;
    return { ...(value ? { inputTokens: value.input + value.cacheRead + value.cacheWrite,
      cachedInputTokens: value.cacheRead, outputTokens: value.output, totalTokens: value.total } : {}), ...this.context };
  }
  private message(phase: "message" | "reasoning", text: string, done = false): AgentStreamEvent {
    return { id: `${this.current}:${phase}`, phase, text, replace: true, done, ...(phase === "message" ? { group: "work-log" as const } : {}) };
  }
  consume(record: PiRecord): AgentStreamEvent[] {
    const message = piObject(record.message);
    const nativeId = typeof message.id === "string" ? message.id : undefined;
    if (record.type === "message_start" && message.role === "assistant") {
      this.current = (nativeId ? this.messageIds.get(nativeId) : undefined) ?? `${this.prefix}:message-${++this.sequence}`;
      if (nativeId) this.messageIds.set(nativeId, this.current);
      this.blocks.clear(); this.error = undefined; return [];
    }
    if (record.type === "message_update") {
      if (!this.current) this.current = `${this.prefix}:message-${++this.sequence}`;
      const update = piObject(record.assistantMessageEvent), type = String(update.type);
      const phase = type.startsWith("thinking_") ? "reasoning" : type.startsWith("text_") ? "message" : undefined;
      const usage = totals(record.usage); if (usage) this.usages.set(this.current, usage);
      if (!phase) return [];
      const key = `${phase}:${typeof update.contentIndex === "number" ? update.contentIndex : 0}`;
      if (type.endsWith("_delta") && typeof update.delta === "string") this.blocks.set(key, (this.blocks.get(key) ?? "") + update.delta);
      else if (type.endsWith("_end") && typeof update.content === "string") this.blocks.set(key, update.content);
      const text = [...this.blocks].filter(([block]) => block.startsWith(`${phase}:`)).map(([, value]) => value).join("\n");
      return [this.message(phase, text), ...(this.usage() ? [{ phase: "status" as const, text: "", usage: this.usage()! }] : [])];
    }
    if (record.type === "message_end" && message.role === "assistant") {
      if (nativeId) {
        const known = this.messageIds.get(nativeId);
        this.current = known ?? `${this.prefix}:message-${++this.sequence}`;
        this.messageIds.set(nativeId, this.current);
      }
      if (!this.current) this.current = `${this.prefix}:message-${++this.sequence}`;
      const usage = totals(message.usage); if (usage) this.usages.set(this.current, usage);
      this.stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
      this.error = ["error", "aborted"].includes(this.stopReason) ? piText(message.errorMessage, `Pi assistant ${this.stopReason}.`) : undefined;
      this.finalText = contentText(message.content, "text");
      return [this.message("message", this.finalText, true), ...(contentText(message.content, "thinking") ? [this.message("reasoning", contentText(message.content, "thinking"), true)] : []),
        ...(this.usage() ? [{ phase: "status" as const, text: "", usage: this.usage()! }] : [])];
    }
    if (record.type.startsWith("tool_execution_")) {
      const done = record.type === "tool_execution_end", name = piText(record.toolName, "Tool");
      const result = piObject(done ? record.result : record.partialResult);
      return [{ id: `${this.prefix}:tool:${String(record.toolCallId)}`, phase: "tool", group: "work-log", title: name,
        text: contentText(result.content, "text") || JSON.stringify(record.args ?? {}), replace: true, done,
        toolKind: ["bash", "powershell"].includes(name) ? "command" : ["read", "write", "edit", "grep", "find", "ls"].includes(name) ? "file" : "step" }];
    }
    if (record.type === "dext_todo") {
      const items = Array.isArray(record.todos) ? record.todos.map((raw) => ({ ...piObject(raw), content: piObject(raw).text })) : undefined;
      const todos = normalizeAgentTodos(items, "acp");
      return todos ? [{ phase: "todo", text: "", todos }] : [];
    }
    if (/^(auto_retry_|compaction_|summarization_retry_)/.test(record.type)) return [{ phase: "status", text: "", title: record.type.replaceAll("_", " "),
      ...(record.type === "auto_retry_end" && record.success === false ? { text: piText(record.finalError, "Pi retries exhausted.") } : {}) }];
    return [];
  }
}
