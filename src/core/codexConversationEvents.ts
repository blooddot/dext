import type { AgentInputQuestion, AgentStreamEvent } from "./types.js";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown): string => typeof value === "string" ? value : "";

/** Both native request_user_input and newer asynchronous question messages. */
export function codexInputQuestions(value: unknown, async = false): AgentInputQuestion[] {
  if (!Array.isArray(value) || value.length > 20) return [];
  const questions = value.map((raw, index) => {
    const q = object(raw);
    return {
      id: async ? `question-${index + 1}` : text(q.id), header: text(q.header),
      question: text(async ? q.title : q.question), isSecret: q.isSecret === true,
      options: Array.isArray(q.options) ? q.options.map((option) => ({
        label: text(async ? option : object(option).label), description: text(object(option).description)
      })).filter((option) => option.label) : []
    };
  });
  return questions.every((q) => q.id && q.question) && new Set(questions.map((q) => q.id)).size === questions.length ? questions : [];
}

export function codexConversationEvent(method: string, params: Record<string, unknown>): AgentStreamEvent | undefined {
  const id = text(params.itemId);
  if (method === "turn/plan/updated" && Array.isArray(params.plan)) {
    return { phase: "todo", text: "", todos: params.plan.map((raw, index) => {
      const step = object(raw);
      return { id: `codex-${index}`, text: text(step.step), status: step.status === "completed" ? "completed"
        : step.status === "inProgress" || step.status === "in_progress" ? "in_progress" : "pending" };
    }) };
  }
  if (method === "thread/tokenUsage/updated") {
    const usage = object(object(params.tokenUsage).last);
    return { phase: "status", text: "", usage: {
      inputTokens: usage.inputTokens as number, cachedInputTokens: usage.cachedInputTokens as number,
      outputTokens: usage.outputTokens as number, totalTokens: usage.totalTokens as number
    } };
  }
  if (method === "item/agentMessage/delta" || method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    return { id, phase: method.includes("reasoning") ? "reasoning" : "message", text: text(params.delta) };
  }
  if (method === "item/commandExecution/outputDelta") return { id, phase: "tool", text: text(params.delta), toolKind: "command" };
  if (method !== "item/started" && method !== "item/completed") return undefined;
  const item = object(params.item);
  const common = { id: text(item.id), replace: true, done: method === "item/completed", eventType: method };
  if (item.type === "agentMessage") {
    if (item.delivery === "async" && codexInputQuestions(item.questions, true).length) return undefined;
    return { ...common, phase: "message", text: text(item.text) };
  }
  if (item.type === "reasoning") return { ...common, phase: "reasoning", text: (Array.isArray(item.summary) && item.summary.length
    ? item.summary : Array.isArray(item.content) ? item.content : []).map(text).join("\n\n") };
  if (item.type === "commandExecution") return { ...common, phase: "tool", toolKind: "command", title: text(item.command), text: text(item.aggregatedOutput) };
  if (item.type === "fileChange") return { ...common, phase: "tool", toolKind: "file", title: "File changes", text: (Array.isArray(item.changes) ? item.changes : []).map((raw) => {
    const change = object(raw); return `${text(change.path)}\n${text(change.diff)}`;
  }).join("\n\n") };
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView"].includes(text(item.type))) {
    return { ...common, phase: "tool", toolKind: item.type === "imageView" ? "image" : "step",
      title: text(item.tool) || text(item.type), text: text(item.path) || text(item.query) || JSON.stringify(item.result ?? item.arguments ?? item.status ?? "") };
  }
  return undefined;
}
