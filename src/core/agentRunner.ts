import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { isDextResult, serializeResultForAgent } from "./resultSerialization.js";
import { ExecutionCancelledError } from "./executionErrors.js";
import type { AgentProfile } from "../agentProfiles.js";
import type { AxMethodContract } from "./axAdapter.js";
import type { AgentStreamEvent, AgentStreamPhase, ExecutionMetadata, RegisteredCallable, ResolvedInvocation } from "./types.js";

export interface AgentExecutionRequest {
  profile: AgentProfile;
  model?: string;
  reasoningEffort?: string;
  speed?: string;
  serviceTier?: string;
  cwd: string;
  method: RegisteredCallable;
  resolved: ResolvedInvocation;
  contract: AxMethodContract;
  metadata: Readonly<ExecutionMetadata>;
  /** Only agent(apply=true) may receive a trusted workspace-write sandbox. */
  allowWorkspaceWrite?: boolean;
  onEvent?: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

/** An unstructured user conversation. Unlike Dext APIs, it has no JSON
 * envelope or output schema and its result is ordinary assistant text. */
export interface AgentConversationRequest {
  profile: AgentProfile;
  mode: "agent" | "ask";
  model?: string;
  reasoningEffort?: string;
  speed?: string;
  serviceTier?: string;
  cwd: string;
  input: string;
  metadata: Readonly<ExecutionMetadata>;
  allowWorkspaceWrite: boolean;
  onEvent?: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

export interface AgentRunner {
  run(request: AgentExecutionRequest): Promise<unknown>;
  runConversation?(request: AgentConversationRequest): Promise<string>;
  endSession?(sessionId: string): void;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

interface CommandResolutionOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function agentProcessEnvironment(
  provider: AgentProfile["provider"],
  usesChatGptLogin: boolean,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv | undefined {
  if (provider !== "codex" || !usesChatGptLogin) return undefined;
  const env = { ...source };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

function configuredCodexCliPath(options: Required<CommandResolutionOptions>): string | undefined {
  const codexHome = options.env.CODEX_HOME || join(options.home, ".codex");
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) return undefined;
  try {
    const content = readFileSync(configPath, "utf8");
    const value = /^\s*CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]\s*$/m.exec(content)?.[1];
    return value?.replace(/\\\\/g, "\\");
  } catch {
    return undefined;
  }
}

function windowsCommandCandidates(
  command: string,
  provider: AgentProfile["provider"],
  options: Required<CommandResolutionOptions>
): string[] {
  const trimmed = command.trim();
  const hasPath = isAbsolute(trimmed) || trimmed.includes("\\") || trimmed.includes("/");
  const extensions = (options.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  const names = hasPath || extname(trimmed)
    ? [trimmed]
    : [trimmed, ...extensions.map((extension) => `${trimmed}${extension}`)];

  if (provider === "codex" && trimmed.toLowerCase() === "codex") {
    const configuredPath = configuredCodexCliPath(options);
    if (configuredPath) names.unshift(configuredPath);
    const codexHome = options.env.CODEX_HOME || join(options.home, ".codex");
    names.push(join(codexHome, ".sandbox-bin", "codex.exe"));
    if (options.env.LOCALAPPDATA) {
      names.push(join(options.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
    }
  }
  if (provider === "claude" && trimmed.toLowerCase() === "claude") {
    names.push(join(options.home, ".local", "bin", "claude.exe"));
    if (options.env.APPDATA) names.push(join(options.env.APPDATA, "npm", "claude.cmd"));
  }
  return [...new Set(names)];
}

/**
 * Resolve a configured CLI without requiring the extension host to inherit the
 * same PATH as the user's terminal. Windows CLI installs commonly expose a
 * `.cmd` shim; Codex Desktop and Claude Code's native installer also have
 * provider-specific executable locations.
 */
export function resolveCliCommand(
  command: string,
  provider: AgentProfile["provider"],
  input: CommandResolutionOptions = {}
): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;
  const options: Required<CommandResolutionOptions> = {
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
    home: input.home ?? homedir()
  };
  if (options.platform !== "win32") return trimmed;

  for (const candidate of windowsCommandCandidates(trimmed, provider, options)) {
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
    if (isAbsolute(candidate)) continue;
    for (const directory of (options.env.Path ?? options.env.PATH ?? "").split(delimiter)) {
      if (!directory) continue;
      const resolved = join(directory, candidate);
      if (existsSync(resolved)) return resolved;
    }
  }
  return undefined;
}

export function displayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(displayValue);
  if (isDextResult(value)) return serializeResultForAgent(value);
  if (typeof value === "object" && value !== null && "content" in value && "uri" in value) {
    const reference = value as { uri?: string; content?: string; range?: unknown; symbol?: string };
    return { uri: reference.uri, content: reference.content, range: reference.range, symbol: reference.symbol };
  }
  return value;
}

type JsonSchema = Record<string, unknown>;

function nullableSchema(schema: JsonSchema): JsonSchema {
  if (schema.type === "null") return schema;
  if (typeof schema.type === "string") {
    return { ...schema, type: [schema.type, "null"] };
  }
  if (Array.isArray(schema.type) && !schema.type.includes("null")) {
    return { ...schema, type: [...schema.type.filter((item): item is string => typeof item === "string"), "null"] };
  }
  return { anyOf: [schema, { type: "null" }] };
}

/** Codex strict structured output requires every object property to be required. */
export function codexOutputSchema(value: object): object {
  return codexSchema(value, false) as object;
}

function codexSchema(value: unknown, optional = false): unknown {
  if (Array.isArray(value)) return value.map((item) => codexSchema(item));
  if (typeof value !== "object" || value === null) return value;
  const schema = { ...(value as JsonSchema) };
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const properties = schema.properties as Record<string, unknown>;
    const declaredRequired = new Set(
      Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []
    );
    schema.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [
      key,
      codexSchema(child, !declaredRequired.has(key))
    ]));
    schema.required = Object.keys(properties);
  }
  if ("items" in schema) schema.items = codexSchema(schema.items);
  for (const key of ["additionalProperties", "anyOf", "oneOf", "allOf"]) {
    if (key in schema) schema[key] = codexSchema(schema[key]);
  }
  return optional ? nullableSchema(schema) : schema;
}

/** Stable invocation envelope for stateless CLI agent adapters. */
export function agentPayload(request: AgentExecutionRequest): string {
  return JSON.stringify({
    api: request.method.id,
    description: request.method.description,
    ...(request.metadata.instruction ? { instruction: request.metadata.instruction } : {}),
    arguments: Object.fromEntries(Object.entries(request.resolved.arguments).map(([key, value]) => [key, displayValue(value)])),
    // Inline inputs are readable @path tokens and are sent unchanged.
    context: ["ask", "agent"].includes(request.method.id)
      ? []
      : request.resolved.context.map(displayValue)
  });
}

function extractJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

function stripNullProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullProperties);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, stripNullProperties(child)])
  );
}

export function extractClaudeResult(output: string): unknown {
  let finalResult: unknown;
  for (const line of output.split(/\r?\n/)) {
    const event = extractJson(line);
    if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "result") continue;
    const result = event as { structured_output?: unknown; result?: unknown };
    if (result.structured_output !== undefined) finalResult = result.structured_output;
    else if (typeof result.result === "string") finalResult = extractJson(result.result) ?? result.result;
    else if (result.result !== undefined) finalResult = result.result;
  }
  if (finalResult !== undefined) return stripNullProperties(finalResult);
  const parsed = extractJson(output);
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    const result = (parsed as { result?: unknown }).result;
    if (typeof result === "string") return extractJson(result) ?? result;
    return stripNullProperties(result);
  }
  return stripNullProperties(parsed ?? output);
}

function extractAgentValue(output: string, provider: AgentProfile["provider"]): unknown {
  if (provider === "codex") {
    let finalText = "";
    for (const line of output.split(/\r?\n/)) {
      const event = extractJson(line);
      if (!event || typeof event !== "object") continue;
      const item = (event as { item?: { type?: string; text?: string } }).item;
      if (item?.type === "agent_message" && typeof item.text === "string") finalText = item.text;
    }
    return stripNullProperties(extractJson(finalText) ?? finalText);
  }
  return extractClaudeResult(output);
}

/** Extracts a normal assistant reply without attempting to parse it as a
 * Dext result. A conversation is allowed to contain arbitrary text or JSON. */
export function extractConversationText(output: string, provider: AgentProfile["provider"]): string {
  if (provider === "codex") {
    let finalText = "";
    for (const line of output.split(/\r?\n/)) {
      const event = extractJson(line);
      if (!event || typeof event !== "object") continue;
      const item = (event as { item?: { type?: string; text?: string } }).item;
      if (item?.type === "agent_message" && typeof item.text === "string") finalText = item.text;
    }
    return finalText || output.trim();
  }
  const result = extractClaudeResult(output);
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function eventText(event: Record<string, unknown>, item?: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    event.delta,
    event.text,
    event.message,
    item?.delta,
    item?.text,
    item?.message,
    item?.command,
    item?.aggregated_output,
    item?.summary,
    item?.content
  ];
  const findText = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value.map(findText).filter((part): part is string => Boolean(part)).join("") || undefined;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.delta === "string") return record.delta;
      return findText(record.content) ?? findText(record.summary);
    }
    return undefined;
  };
  return candidates.map(findText).find((value): value is string => Boolean(value));
}

function isStructuredAgentResult(text: string): boolean {
  const parsed = extractJson(text);
  return typeof parsed === "object" && parsed !== null && typeof (parsed as { kind?: unknown }).kind === "string";
}

export function parseCodexStreamLine(
  line: string,
  streamPhases: Map<string, AgentStreamPhase> = new Map()
): AgentStreamEvent | undefined {
  const parsed = extractJson(line);
  if (!parsed || typeof parsed !== "object") return undefined;
  const event = parsed as Record<string, unknown>;
  const eventType = typeof event.type === "string" ? event.type : undefined;
  if (!eventType || eventType === "thread.started" || eventType === "turn.started") return undefined;
  const item = typeof event.item === "object" && event.item !== null
    ? event.item as Record<string, unknown>
    : undefined;
  const eventItemId = typeof event.item_id === "string" ? event.item_id : undefined;
  const itemType = typeof item?.type === "string" ? item.type : undefined;
  const text = eventText(event, item);
  const eventId = typeof event.id === "string"
    ? event.id
    : typeof item?.id === "string" ? item.id : eventItemId;
  let phase: AgentStreamPhase = eventItemId ? streamPhases.get(eventItemId) ?? "message" : "status";
  if (itemType === "reasoning" || itemType === "analysis" || eventType.includes("reasoning")) phase = "reasoning";
  else if (itemType === "agent_message" || eventType.includes("message") || eventType.includes("output_text")) phase = "message";
  else if (itemType === "command_execution" || itemType === "tool_call" || eventType.includes("tool")) phase = "tool";
  if (eventId && (eventType === "item.started" || itemType)) streamPhases.set(eventId, phase);
  const command = typeof item?.command === "string" ? item.command : undefined;
  const aggregatedOutput = typeof item?.aggregated_output === "string" ? item.aggregated_output : undefined;
  const statusText = phase === "tool" ? (aggregatedOutput || command || text || "") : (text ?? "");
  if (!statusText || (phase === "message" && isStructuredAgentResult(statusText))) return undefined;
  return {
    ...(eventId ? { id: eventId } : {}),
    phase,
    text: statusText,
    ...(command ? { title: command } : {}),
    ...(eventType === "item.updated" || eventType === "item.completed" ? { replace: true } : {}),
    ...(eventType.endsWith("completed") || eventType.endsWith("done") ? { done: true } : {}),
    eventType
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function claudeContentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    const block = record(item);
    if (!block || block.type === "thinking") return [];
    if (typeof block.text === "string") return [block.text];
    if (typeof block.content === "string") return [block.content];
    return [];
  }).join("");
  return text || undefined;
}

function claudeToolText(block: Record<string, unknown>): string {
  const input = record(block.input);
  if (!input) return typeof block.input === "string" ? block.input : "";
  if (typeof input.command === "string") return input.command;
  return Object.keys(input).length ? JSON.stringify(input) : "";
}

/** Parse the public `stream-json` events emitted by Claude Code's print mode. */
export function parseClaudeStreamLine(line: string): AgentStreamEvent | undefined {
  const parsed = extractJson(line);
  const event = record(parsed);
  if (!event) return undefined;
  const eventType = typeof event.type === "string" ? event.type : "";
  if (!eventType || eventType === "system" || eventType === "result") return undefined;

  if (eventType === "stream_event") {
    const stream = record(event.event);
    const streamType = typeof stream?.type === "string" ? stream.type : "";
    if (streamType === "content_block_delta") {
      const delta = record(stream?.delta);
      if (delta?.type === "thinking_delta" || typeof delta?.thinking === "string") return undefined;
      const text = typeof delta?.text === "string" ? delta.text : undefined;
      if (!text) return undefined;
      const index = typeof stream?.index === "number" ? stream.index : 0;
      return { id: `claude-stream-${index}`, phase: "message", text, eventType };
    }
    if (streamType === "content_block_start") {
      const block = record(stream?.content_block);
      if (block?.type !== "tool_use") return undefined;
      const id = typeof block.id === "string" ? block.id : undefined;
      const title = typeof block.name === "string" ? block.name : "Tool";
      const text = claudeToolText(block) || title;
      return { ...(id ? { id } : {}), phase: "tool", title, text, eventType };
    }
    return undefined;
  }

  const message = record(event.message);
  const blocks = Array.isArray(message?.content) ? message.content : [];
  if (eventType === "assistant") {
    const tool = blocks.map(record).find((block) => block?.type === "tool_use");
    if (tool) {
      const id = typeof tool.id === "string" ? tool.id : undefined;
      const title = typeof tool.name === "string" ? tool.name : "Tool";
      const text = claudeToolText(tool) || title;
      return { ...(id ? { id } : {}), phase: "tool", title, text, eventType };
    }
    const text = claudeContentText(message?.content);
    if (!text || isStructuredAgentResult(text)) return undefined;
    const id = typeof message?.id === "string" ? message.id : undefined;
    return { ...(id ? { id } : {}), phase: "message", text, eventType, done: true };
  }
  if (eventType === "user") {
    const result = blocks.map(record).find((block) => block?.type === "tool_result");
    if (!result) return undefined;
    const id = typeof result.tool_use_id === "string" ? result.tool_use_id : undefined;
    const text = claudeContentText(result.content) || "Completed";
    return { ...(id ? { id } : {}), phase: "tool", text, replace: true, done: true, eventType };
  }
  return undefined;
}

function codexFailure(output: string): string | undefined {
  let message: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const parsed = extractJson(line);
    if (!parsed || typeof parsed !== "object") continue;
    const event = parsed as { type?: unknown; message?: unknown; error?: { message?: unknown } };
    if (event.type === "turn.failed" && typeof event.error?.message === "string") message = event.error.message;
    else if (event.type === "error" && typeof event.message === "string") message = event.message;
  }
  return message;
}

function claudeFailure(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const event = extractJson(line);
    if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "result") continue;
    const result = event as { is_error?: unknown; result?: unknown; subtype?: unknown };
    if (result.is_error === true || result.subtype === "error") {
      return typeof result.result === "string" ? result.result : "Claude Code returned an error result.";
    }
  }
  return undefined;
}

/** Arguments for Claude Code's non-interactive, structured streaming mode. */
export function claudeCliArguments(
  options: Pick<AgentExecutionRequest, "model" | "reasoningEffort" | "allowWorkspaceWrite">,
  outputSchema: object
): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--json-schema", JSON.stringify(outputSchema),
    "--no-session-persistence",
    "--permission-mode", options.allowWorkspaceWrite ? "acceptEdits" : "plan",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.reasoningEffort ? ["--effort", options.reasoningEffort] : [])
  ];
}

/** Claude's stream mode without a Dext output contract. */
export function claudeConversationArguments(
  options: Pick<AgentConversationRequest, "model" | "reasoningEffort" | "allowWorkspaceWrite">
): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--permission-mode", options.allowWorkspaceWrite ? "acceptEdits" : "plan",
    ...(options.model ? ["--model", options.model] : []),
    ...(options.reasoningEffort ? ["--effort", options.reasoningEffort] : [])
  ];
}

/** Arguments for Codex's structured execution mode. Workspace writes are only
 * enabled for an explicitly trusted agent(apply=true) request. */
export function codexCliArguments(
  options: Pick<AgentExecutionRequest, "model" | "reasoningEffort" | "allowWorkspaceWrite">,
  schemaPath: string,
  allowWorkspaceWrite: boolean,
  serviceTier?: string
): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox", allowWorkspaceWrite ? "workspace-write" : "read-only",
    "--output-schema", schemaPath,
    ...(allowWorkspaceWrite ? ["--skip-git-repo-check"] : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.reasoningEffort ? ["--config", 'model_reasoning_effort="' + options.reasoningEffort + '"'] : []),
    "--config", 'model_reasoning_summary="detailed"',
    ...(serviceTier ? ["--config", 'service_tier="' + serviceTier + '"'] : []),
    "-"
  ];
}

/** Codex's JSON event stream is used only for Process rendering. No JSON
 * schema is passed, so the final assistant message remains ordinary text. */
export function codexConversationArguments(
  options: Pick<AgentConversationRequest, "model" | "reasoningEffort" | "allowWorkspaceWrite">,
  serviceTier?: string
): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--sandbox", options.allowWorkspaceWrite ? "workspace-write" : "read-only",
    ...(options.allowWorkspaceWrite ? ["--skip-git-repo-check"] : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.reasoningEffort ? ["--config", 'model_reasoning_effort="' + options.reasoningEffort + '"'] : []),
    "--config", 'model_reasoning_summary="detailed"',
    ...(serviceTier ? ["--config", 'service_tier="' + serviceTier + '"'] : []),
    "-"
  ];
}

export function runProcess(
  command: string,
  args: readonly string[],
  input: string,
  cwd: string,
  signal?: AbortSignal,
  onStdout?: (chunk: string) => void,
  env?: NodeJS.ProcessEnv
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const child = spawn(command, [...args], { cwd, windowsHide: true, shell, ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborting = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      if (aborting || settled) return;
      aborting = true;
      const terminate = (): Promise<void> => {
        if (process.platform !== "win32" || child.pid === undefined) {
          child.kill();
          return Promise.resolve();
        }
        return new Promise((done) => {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore"
          });
          killer.once("error", () => {
            child.kill();
            done();
          });
          killer.once("close", () => done());
        });
      };
      const signalReason: unknown = signal?.reason;
      const reason = signalReason instanceof Error && signalReason.name !== "AbortError"
        ? signalReason
        : new ExecutionCancelledError();
      void terminate().finally(() => finish(() => reject(reason)));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      if (!aborting) finish(() => reject(new Error(`Unable to start '${command}': ${error.message}`)));
    });
    child.on("close", (code) => {
      if (!aborting) finish(() => resolve({ stdout, stderr, code }));
    });
    child.stdin.end(input);
  });
}

export class CliAgentRunner implements AgentRunner {
  private codexUsesChatGpt: boolean | undefined;

  constructor(private readonly timeoutMs = 600_000) {}

  private async processEnvironment(
    command: string,
    request: Pick<AgentExecutionRequest | AgentConversationRequest, "profile" | "cwd" | "signal">
  ): Promise<NodeJS.ProcessEnv | undefined> {
    if (request.profile.provider !== "codex") return undefined;
    if (this.codexUsesChatGpt === undefined) {
      try {
        const status = await runProcess(command, ["login", "status"], "", request.cwd, request.signal);
        this.codexUsesChatGpt = status.code === 0 && /logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr}`);
      } catch (error) {
        if (error instanceof ExecutionCancelledError) throw error;
        this.codexUsesChatGpt = false;
      }
    }
    return agentProcessEnvironment(request.profile.provider, this.codexUsesChatGpt);
  }

  async run(request: AgentExecutionRequest): Promise<unknown> {
    if (request.profile.provider === "aioa") {
      throw new Error("AIOA requests must use the CDP runner.");
    }
    if (!request.profile.command) throw new Error(`Agent '${request.profile.label}' has no CLI command configured.`);
    if (request.signal?.aborted) throw new ExecutionCancelledError();
    const configuredCommand = request.profile.command.trim();
    const command = resolveCliCommand(configuredCommand, request.profile.provider);
    if (!command) {
      throw new Error(
        `Unable to start '${configuredCommand}': command was not found. `
        + `Install ${request.profile.label} or use "Dext: Configure Agent CLI" to set its executable path.`
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "dext-agent-"));
    const schemaPath = join(directory, "output-schema.json");
    const outputSchema = request.profile.provider === "codex"
      ? codexOutputSchema(request.contract.outputJsonSchema)
      : request.contract.outputJsonSchema;
    await writeFile(schemaPath, JSON.stringify(outputSchema), "utf8");
    const input = agentPayload(request);
    const progressInstruction = "While working, emit concise progress updates that summarize what you are inspecting and why, without exposing hidden chain-of-thought. The final agent message must contain only JSON matching the native structured-output schema.";
    const prompt = request.method.id === "agent" && request.allowWorkspaceWrite
        ? `Read the Dext JSON payload from stdin. You may modify files only inside the current trusted workspace. Do not install packages or change files outside this workspace. Return an AgentResult, including an auditable patch whenever changes can be represented. ${progressInstruction}`
        : request.method.id === "agent"
          ? `Read the Dext JSON payload from stdin. This is preview-only: do not modify workspace files, install packages, or run state-changing commands. Return an AgentResult. When the task requests a change, include a complete applicable patch with exact before and after content. ${progressInstruction}`
          : `Read the Dext JSON payload from stdin. Values tagged kind=dext-result are prior typed API results; inspect their value field. Execute the requested API without modifying workspace files, installing packages, or running state-changing commands. ${progressInstruction}`;
    const serviceTier = request.serviceTier ?? (request.speed === "fast" ? "priority" : request.speed === "standard" ? "default" : undefined);
    const processEnv = await this.processEnvironment(command, request);
    const args: string[] = request.profile.provider === "codex"
      ? codexCliArguments(request, schemaPath, request.allowWorkspaceWrite === true, serviceTier)
      : claudeCliArguments(request, outputSchema);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("Agent execution timed out.")), this.timeoutMs);
      const cancel = (): void => controller.abort(new ExecutionCancelledError());
      request.signal?.addEventListener("abort", cancel, { once: true });
      if (request.signal?.aborted) cancel();
      let eventBuffer = "";
      const streamPhases = new Map<string, AgentStreamPhase>();
      const emitCodexLine = (line: string): void => {
        const event = parseCodexStreamLine(line, streamPhases);
        if (event) request.onEvent?.(event);
      };
      const emitClaudeLine = (line: string): void => {
        const event = parseClaudeStreamLine(line);
        if (event) request.onEvent?.(event);
      };
      const onStdout = request.profile.provider === "codex" || request.profile.provider === "claude"
        ? (chunk: string): void => {
            eventBuffer += chunk;
            const lines = eventBuffer.split(/\r?\n/);
            eventBuffer = lines.pop() ?? "";
            for (const line of lines) {
              if (request.profile.provider === "codex") emitCodexLine(line);
              else emitClaudeLine(line);
            }
          }
        : undefined;
      const stdin = request.profile.provider === "codex"
        ? `${prompt}\n\n${input}`
        : `${prompt}\n\nDext JSON payload:\n${input}`;
      let result: ProcessResult;
      try {
        result = await runProcess(command, args, stdin, request.cwd, controller.signal, onStdout, processEnv);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
      }
      if (eventBuffer && request.profile.provider === "codex") emitCodexLine(eventBuffer);
      if (eventBuffer && request.profile.provider === "claude") emitClaudeLine(eventBuffer);
      if (result.code !== 0) {
        const structuredFailure = request.profile.provider === "codex"
          ? codexFailure(result.stdout)
          : request.profile.provider === "claude" ? claudeFailure(result.stdout) : undefined;
        const details = structuredFailure ?? [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
        throw new Error(`${request.profile.label} exited with code ${result.code ?? "unknown"}${details ? `:\n${details}` : ""}`);
      }
      const value = extractAgentValue(result.stdout, request.profile.provider);
      if (value === undefined || value === "") throw new Error(`${request.profile.label} returned no structured result.`);
      return value;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async runConversation(request: AgentConversationRequest): Promise<string> {
    if (request.profile.provider === "aioa") {
      throw new Error("AIOA requests must use the CDP runner.");
    }
    if (!request.profile.command) throw new Error(`Agent '${request.profile.label}' has no CLI command configured.`);
    if (request.signal?.aborted) throw new ExecutionCancelledError();
    const command = resolveCliCommand(request.profile.command.trim(), request.profile.provider);
    if (!command) {
      throw new Error(
        `Unable to start '${request.profile.command.trim()}': command was not found. `
        + `Install ${request.profile.label} or use "Dext: Configure Agent CLI" to set its executable path.`
      );
    }
    const serviceTier = request.serviceTier ?? (request.speed === "fast" ? "priority" : request.speed === "standard" ? "default" : undefined);
    const args = request.profile.provider === "codex"
      ? codexConversationArguments(request, serviceTier)
      : claudeConversationArguments(request);
    const processEnv = await this.processEnvironment(command, request);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Agent execution timed out.")), this.timeoutMs);
    const cancel = (): void => controller.abort(new ExecutionCancelledError());
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    let eventBuffer = "";
    const streamPhases = new Map<string, AgentStreamPhase>();
    const onStdout = (chunk: string): void => {
      eventBuffer += chunk;
      const lines = eventBuffer.split(/\r?\n/);
      eventBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = request.profile.provider === "codex"
          ? parseCodexStreamLine(line, streamPhases)
          : parseClaudeStreamLine(line);
        if (event) request.onEvent?.(event);
      }
    };
    try {
      const result = await runProcess(command, args, request.input, request.cwd, controller.signal, onStdout, processEnv);
      if (eventBuffer) {
        const event = request.profile.provider === "codex"
          ? parseCodexStreamLine(eventBuffer, streamPhases)
          : parseClaudeStreamLine(eventBuffer);
        if (event) request.onEvent?.(event);
      }
      if (result.code !== 0) {
        const details = request.profile.provider === "codex"
          ? codexFailure(result.stdout)
          : claudeFailure(result.stdout);
        throw new Error(`${request.profile.label} exited with code ${result.code ?? "unknown"}${details ? `:\n${details}` : ""}`);
      }
      const text = extractConversationText(result.stdout, request.profile.provider);
      if (!text) throw new Error(`${request.profile.label} returned no response.`);
      return text;
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
    }
  }
}
