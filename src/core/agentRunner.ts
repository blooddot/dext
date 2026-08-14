import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { isDextResult, serializeResultForAgent } from "./resultSerialization.js";
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
  onEvent?: (event: AgentStreamEvent) => void;
}

export interface AgentRunner {
  run(request: AgentExecutionRequest): Promise<unknown>;
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
  return [...new Set(names)];
}

/**
 * Resolve a configured CLI without requiring the extension host to inherit the
 * same PATH as the user's terminal. Windows CLI installs commonly expose a
 * `.cmd` shim, while the Codex desktop app keeps its executable under
 * `%CODEX_HOME%\\.sandbox-bin`.
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

function displayValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(displayValue);
  if (isDextResult(value)) return serializeResultForAgent(value);
  if (typeof value === "object" && value !== null && "content" in value && "uri" in value) {
    const reference = value as { uri?: string; content?: string; range?: unknown; symbol?: string };
    return { uri: reference.uri, content: reference.content, range: reference.range, symbol: reference.symbol };
  }
  return value;
}

function isCodeReference(value: unknown): value is ResolvedInvocation["context"][number] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "kind" in value && value.kind === "codeRef";
}

function previewFileName(uri: string, index: number): string {
  const tail = decodeURIComponent(uri.replaceAll("\\", "/").split("/").pop() ?? "");
  const safe = tail.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || `target-${index + 1}.txt`;
}

async function isolatedEditRequest(
  request: AgentExecutionRequest,
  directory: string
): Promise<AgentExecutionRequest> {
  if (request.method.id !== "code.edit") return request;
  const raw = request.resolved.arguments.target;
  const targets = (Array.isArray(raw) ? raw : [raw]).filter(isCodeReference);
  const replacements = new Map<string, ResolvedInvocation["context"][number]>();
  for (const [index, target] of targets.entries()) {
    const relative = `target-${index + 1}/${previewFileName(target.uri, index)}`;
    const filePath = join(directory, ...relative.split("/"));
    await mkdir(join(directory, `target-${index + 1}`), { recursive: true });
    await writeFile(filePath, target.content, "utf8");
    replacements.set(`${target.uri}|${target.contentHash}`, { ...target, uri: relative });
  }
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace);
    if (!isCodeReference(value)) return value;
    return replacements.get(`${value.uri}|${value.contentHash}`) ?? value;
  };
  return {
    ...request,
    cwd: directory,
    resolved: {
      ...request.resolved,
      arguments: Object.fromEntries(
        Object.entries(request.resolved.arguments).map(([name, value]) => [name, replace(value)])
      ) as ResolvedInvocation["arguments"],
      context: request.resolved.context.map((value) => replace(value) as ResolvedInvocation["context"][number])
    }
  };
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

function payload(request: AgentExecutionRequest, outputSchema: object): string {
  return JSON.stringify({
    api: request.method.id,
    description: request.method.description,
    arguments: Object.fromEntries(Object.entries(request.resolved.arguments).map(([key, value]) => [key, displayValue(value)])),
    context: request.resolved.context.map(displayValue),
    output_schema: outputSchema
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
  const parsed = extractJson(output);
  if (parsed && typeof parsed === "object" && "result" in parsed) {
    const result = (parsed as { result?: unknown }).result;
    if (typeof result === "string") return extractJson(result) ?? result;
    return stripNullProperties(result);
  }
  return stripNullProperties(parsed ?? output);
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

function runProcess(
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
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => {
      child.kill();
      finish(() => reject(new Error("Agent execution was cancelled.")));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish(() => reject(new Error(`Unable to start '${command}': ${error.message}`))));
    child.on("close", (code) => finish(() => resolve({ stdout, stderr, code })));
    child.stdin.end(input);
  });
}

export class CliAgentRunner implements AgentRunner {
  private codexUsesChatGpt: boolean | undefined;

  constructor(private readonly timeoutMs = 600_000) {}

  private async processEnvironment(command: string, request: AgentExecutionRequest): Promise<NodeJS.ProcessEnv | undefined> {
    if (request.profile.provider !== "codex") return undefined;
    if (this.codexUsesChatGpt === undefined) {
      try {
        const status = await runProcess(command, ["login", "status"], "", request.cwd);
        this.codexUsesChatGpt = status.code === 0 && /logged in using chatgpt/i.test(`${status.stdout}\n${status.stderr}`);
      } catch {
        this.codexUsesChatGpt = false;
      }
    }
    return agentProcessEnvironment(request.profile.provider, this.codexUsesChatGpt);
  }

  async run(request: AgentExecutionRequest): Promise<unknown> {
    if (!request.profile.command) throw new Error(`Agent '${request.profile.label}' has no CLI command configured.`);
    const configuredCommand = request.profile.command.trim();
    const command = resolveCliCommand(configuredCommand, request.profile.provider);
    if (!command) {
      throw new Error(
        `Unable to start '${configuredCommand}': command was not found. `
        + `Install ${request.profile.label} or use "Dext: Configure Agent CLI" to set its executable path.`
      );
    }
    const directory = await mkdtemp(join(tmpdir(), "dext-agent-"));
    const executionRequest = await isolatedEditRequest(request, directory);
    const schemaPath = join(directory, "output-schema.json");
    const outputSchema = request.profile.provider === "codex"
      ? codexOutputSchema(request.contract.outputJsonSchema)
      : request.contract.outputJsonSchema;
    await writeFile(schemaPath, JSON.stringify(outputSchema), "utf8");
    const input = payload(executionRequest, outputSchema);
    const progressInstruction = "While working, emit concise progress updates that summarize what you are inspecting and why, without exposing hidden chain-of-thought. The final agent message must contain only JSON matching output_schema.";
    const prompt = request.method.id === "code.edit"
      ? `Read the Dext JSON payload from stdin. Work only with the relative preview target paths in the isolated current directory. Do not access or modify files outside it. Return a preview-only EditResult with complete before and after text; Dext applies it separately. ${progressInstruction}`
      : `Read the Dext JSON payload from stdin. Values tagged kind=dext-result are prior typed API results; inspect their value field. Execute the requested API. ${progressInstruction}`;
    const serviceTier = executionRequest.serviceTier ?? (executionRequest.speed === "fast" ? "priority" : executionRequest.speed === "standard" ? "default" : undefined);
    const processEnv = await this.processEnvironment(command, executionRequest);
    const args: string[] = executionRequest.profile.provider === "codex"
      ? ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "--output-schema", schemaPath,
        ...(request.method.id === "code.edit" ? ["--skip-git-repo-check"] : []),
        ...(executionRequest.model ? ["--model", executionRequest.model] : []),
        ...(executionRequest.reasoningEffort ? ["--config", 'model_reasoning_effort="' + executionRequest.reasoningEffort + '"'] : []),
        "--config", 'model_reasoning_summary="detailed"',
        ...(serviceTier ? ["--config", 'service_tier="' + serviceTier + '"'] : []),
        "-"]
      : ["-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(outputSchema), "--no-session-persistence", "--permission-mode", "plan", ...(executionRequest.model ? ["--model", executionRequest.model] : [])];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let eventBuffer = "";
      const streamPhases = new Map<string, AgentStreamPhase>();
      const emitCodexLine = (line: string): void => {
        const event = parseCodexStreamLine(line, streamPhases);
        if (event) request.onEvent?.(event);
      };
      const onStdout = request.profile.provider === "codex"
        ? (chunk: string): void => {
            eventBuffer += chunk;
            const lines = eventBuffer.split(/\r?\n/);
            eventBuffer = lines.pop() ?? "";
            for (const line of lines) emitCodexLine(line);
          }
        : undefined;
      const stdin = request.profile.provider === "codex"
        ? `${prompt}\n\n${input}`
        : input;
      const result = await runProcess(command, args, stdin, executionRequest.cwd, controller.signal, onStdout, processEnv);
      clearTimeout(timer);
      if (eventBuffer && request.profile.provider === "codex") emitCodexLine(eventBuffer);
      if (result.code !== 0) {
        const structuredFailure = request.profile.provider === "codex" ? codexFailure(result.stdout) : undefined;
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
}
