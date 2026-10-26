import type { AgentMcpServer, AgentPermission } from "./agent.js";
import type { AgentInputQuestion, AgentTodoItem } from "../../../shared/contracts/types.js";

/** The deliberately small wire surface Dext requires from an installed Pi CLI. */
export interface PiRecord { type: string; [key: string]: unknown }
export interface PiModel { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }
export interface PiState { model?: PiModel; thinkingLevel?: string; sessionFile?: string; sessionId?: string }
export interface PiSessionBinding { path: string; binding: string }
export interface PiBridgeConfig {
  permission: AgentPermission;
  tools: string[];
  mcpServers: readonly AgentMcpServer[];
  resultSchema?: Record<string, unknown>;
}
export type PiBridgeRequest =
  | { id: string; kind: "question"; questions: AgentInputQuestion[] }
  | { id: string; kind: "submit_result"; args: unknown }
  | { id: string; kind: "todo"; todos: AgentTodoItem[] };
export interface PiUiRequest extends PiRecord { type: "extension_ui_request"; id: string; method: string }

export function piObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export const piText = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
