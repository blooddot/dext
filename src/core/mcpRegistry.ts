import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { name, version, dext } from "../../package.json";
import type { McpProcessEvent, McpRawResult } from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_TIMEOUT_MS = 30_000;
// Bundled from the extension manifest; independent of the user's workspace.
const MCP_PROTOCOL_VERSIONS = dext.mcpProtocolVersions;

function initializationParams(transport: McpServerConfig["transport"]) {
  return {
    protocolVersion: MCP_PROTOCOL_VERSIONS[transport],
    capabilities: {},
    clientInfo: { name, version }
  };
}
const FORBIDDEN_HTTP_CONFIGURATION_KEYS = new Set([
  "token",
  "headers",
  "secretKey",
  "accessToken",
  "authorization",
  "password",
  "userToken",
  "apiKey"
]);

export interface StdioMcpServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args?: string[];
  /** Inject a SecretStorage token into the named child-process environment variable. */
  auth?: { type: "token"; env: string };
  /** Set by Dext when loading a project/global manifest; not persisted by the manifest writer. */
  scope?: "project" | "global";
  timeoutMs?: number;
}

export interface HttpMcpServerConfig {
  name: string;
  transport: "http";
  url: string;
  auth?: { type: "bearer" };
  /** Set by Dext when loading a project/global manifest; not persisted by the manifest writer. */
  scope?: "project" | "global";
  timeoutMs?: number;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface McpToolConfig {
  server: string;
  tool: string;
  /** MCP is the default; REST tools are executed by Dext's generic adapter. */
  kind?: "mcp" | "rest";
  method?: string;
  url?: string;
  /** Optional human-facing API documentation link. */
  docsUrl?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface RestMcpAdapterOptions {
  fetchImpl?: McpFetch;
}

/** Generic REST-to-MCP adapter. It deliberately knows nothing about any API
 * domain: path placeholders become path parameters and remaining arguments
 * become query parameters (or a JSON body for non-GET requests). */
export class RestMcpAdapter {
  private readonly fetchImpl: McpFetch;
  constructor(options: RestMcpAdapterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async call(tool: McpToolConfig, input: Record<string, unknown>, token?: string): Promise<McpToolCallResult> {
    if (!tool.url || !tool.method) throw new Error(`REST tool '${tool.tool}' requires method and url.`);
    let url = tool.url;
    const used = new Set<string>();
    url = url.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_match, name: string) => {
      used.add(name);
      const value = input[name];
      if (value === undefined || value === null) throw new Error(`REST tool '${tool.tool}' requires '${name}'.`);
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`REST tool '${tool.tool}' path parameter '${name}' must be a string, number, or boolean.`);
      }
      return encodeURIComponent(`${value}`);
    });
    const method = tool.method.toUpperCase();
    const remaining = Object.entries(input).filter(([name]) => !used.has(name));
    const headers = new Headers({ Accept: "application/json, text/plain, */*" });
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const init: RequestInit = { method, headers, redirect: "manual" };
    if (method === "GET" || method === "HEAD" || method === "DELETE") {
      const query = new URLSearchParams();
      for (const [name, value] of remaining) if (value !== undefined && value !== null) query.set(name, typeof value === "string" ? value : JSON.stringify(value));
      if ([...query].length) url += `${url.includes("?") ? "&" : "?"}${query}`;
    } else if (remaining.length) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(Object.fromEntries(remaining));
    }
    const response = await this.fetchImpl(url, init);
    if (!response.ok) throw new Error(`REST tool '${tool.tool}' returned HTTP ${response.status}.`);
    const text = await response.text();
    if (!text) return {};
    try {
      const value: unknown = JSON.parse(text);
      return isRecord(value) ? { structuredContent: value } : { content: text };
    } catch {
      return { content: text };
    }
  }
}

export interface McpToolCallResult {
  content?: string;
  structuredContent?: Record<string, unknown>;
}

/** A tool returned by the MCP `tools/list` capability. */
export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface McpTransportOptions {
  accessToken?: string;
  onProcessEvent?: (event: McpProcessEvent) => void;
}

export interface McpTransport {
  call(
    server: McpServerConfig,
    tool: string,
    argumentsValue: Record<string, unknown>,
    options?: McpTransportOptions
  ): Promise<McpToolCallResult>;
  verify?(server: McpServerConfig, options?: McpTransportOptions): Promise<void>;
  listTools?(server: McpServerConfig, options?: McpTransportOptions): Promise<McpDiscoveredTool[]>;
}

export type McpAccessTokenProvider = (server: McpServerConfig) => Promise<string | undefined>;

export type McpFetch = (url: string, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timeoutFor(server: McpServerConfig): number {
  return server.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((item) => {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return [];
    return [item.text];
  }).join("\n");
  return text || undefined;
}

function toolResult(value: unknown, server: McpServerConfig, tool: string): McpToolCallResult {
  if (!isRecord(value)) throw new Error(`MCP tool '${server.name}.${tool}' returned an invalid response.`);
  if (value.isError === true) throw new Error(`MCP tool '${server.name}.${tool}' reported an error.`);
  const structuredContent = isRecord(value.structuredContent) ? value.structuredContent : undefined;
  const content = textFromContent(value.content);
  return {
    ...(content !== undefined ? { content } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {})
  };
}

function discoveredTools(value: unknown, server: McpServerConfig): McpDiscoveredTool[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) {
    throw new Error(`MCP server '${server.name}' returned an invalid tools/list response.`);
  }
  const tools: McpDiscoveredTool[] = [];
  for (const item of value.tools) {
    if (!isRecord(item) || typeof item.name !== "string" || !IDENTIFIER.test(item.name)) {
      throw new Error(`MCP server '${server.name}' returned an invalid tool name.`);
    }
    tools.push({
      name: item.name,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(isRecord(item.inputSchema) ? { inputSchema: item.inputSchema } : {}),
      ...(isRecord(item.outputSchema) ? { outputSchema: item.outputSchema } : {})
    });
  }
  return tools;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost"
    || host === "::1"
    || host === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function httpUrlDiagnostic(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "requires an HTTP url.";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "has an invalid HTTP url.";
  }
  if (url.username || url.password) return "url must not contain userinfo.";
  if (url.search) return "url must not contain a query string.";
  if (url.hash) return "url must not contain a fragment.";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return undefined;
  return "url must use HTTPS or loopback HTTP.";
}

function configurationKeysDiagnostic(config: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const forbidden = Object.keys(config).find((key) => FORBIDDEN_HTTP_CONFIGURATION_KEYS.has(key));
  if (forbidden) return `must not configure '${forbidden}'; store access tokens with the Dext MCP command instead.`;
  const unexpected = Object.keys(config).find((key) => !allowed.includes(key));
  return unexpected ? `has unsupported configuration field '${unexpected}'.` : undefined;
}

function authDiagnostic(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.type !== "bearer" || Object.keys(value).some((key) => key !== "type")) {
    return "auth must be exactly { type: 'bearer' }.";
  }
  return undefined;
}

function stdioAuthDiagnostic(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.type !== "token" || typeof value.env !== "string"
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.env)
    || Object.keys(value).some((key) => key !== "type" && key !== "env")) {
    return "auth must be { type: 'token', env: '<environment variable name>' } for stdio.";
  }
  return undefined;
}

function normalizeTimeout(value: unknown, name: string, diagnostics: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000 || value > 120_000) {
    diagnostics.push(`MCP server '${name}' timeoutMs must be an integer from 1000 to 120000.`);
    return undefined;
  }
  return value;
}

class StdioJsonRpcClient {
  private nextId = 1;
  private buffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly exited: Promise<void>;

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly serverName: string,
    private readonly timeoutMs: number,
    private readonly onProcessEvent?: (event: McpProcessEvent) => void
  ) {
    this.exited = new Promise((resolve) => this.process.once("exit", () => resolve()));
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => this.consumeStderr(chunk));
    this.process.stderr.on("end", () => this.flushStderr());
    this.process.on("error", () => this.failPending(`MCP server '${serverName}' could not be started.`));
    this.process.on("exit", () => this.failPending(`MCP server '${serverName}' exited before responding.`));
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server '${this.serverName}' timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    if (!this.process.killed) this.process.kill();
    await Promise.race([
      this.exited,
      new Promise<void>((resolve) => setTimeout(resolve, 250))
    ]);
    this.flushStderr();
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) this.failPending(`MCP server '${this.serverName}' is not available.`);
      });
    } catch {
      this.failPending(`MCP server '${this.serverName}' is not available.`);
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.consumeLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let newline = this.stderrBuffer.indexOf("\n");
    while (newline >= 0) {
      this.emitProcessEvent("stderr", this.stderrBuffer.slice(0, newline));
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      newline = this.stderrBuffer.indexOf("\n");
    }
  }

  private flushStderr(): void {
    if (!this.stderrBuffer) return;
    this.emitProcessEvent("stderr", this.stderrBuffer);
    this.stderrBuffer = "";
  }

  private emitProcessEvent(source: McpProcessEvent["source"], text: string): void {
    const normalized = text.trim();
    if (normalized) this.onProcessEvent?.({ source, text: normalized });
  }

  private consumeNotification(message: Record<string, unknown>, raw: string): void {
    const method = typeof message.method === "string" ? message.method : undefined;
    if (method === "notifications/progress" && isRecord(message.params)) {
      const params = message.params;
      const label = typeof params.message === "string" ? params.message : undefined;
      const progress = typeof params.progress === "number" ? params.progress : undefined;
      const total = typeof params.total === "number" ? params.total : undefined;
      const value = progress === undefined ? undefined : total === undefined ? `${progress}` : `${progress}/${total}`;
      this.emitProcessEvent("progress", [label, value].filter((part): part is string => Boolean(part)).join(" · ") || raw);
      return;
    }
    this.emitProcessEvent("stdout", raw);
  }

  private consumeLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Keep the strict failure for lines that look like a damaged JSON
      // message; plain-text lines are treated as server logs for compatibility.
      if (line.startsWith("{") || line.startsWith("[")) {
        this.failPending(`MCP server '${this.serverName}' sent invalid JSON-RPC.`);
      }
      // A few otherwise functional stdio MCP servers write progress logs to
      // stdout.  JSON-RPC reserves stdout for protocol messages, but ignore a
      // non-JSON line here so that a subsequent valid response can still be
      // delivered.  Process exit and request timeouts remain authoritative
      // failures when no response follows.
      this.emitProcessEvent("stdout", line);
      return;
    }
    if (!isRecord(message)) {
      this.emitProcessEvent("stdout", line);
      return;
    }
    if (typeof message.id !== "number") {
      this.consumeNotification(message, line);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.emitProcessEvent("stdout", line);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new Error(`MCP server '${this.serverName}' returned a JSON-RPC error.`));
      return;
    }
    pending.resolve(message.result);
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
  }
}

/** Standard JSON-RPC stdio lifecycle for one MCP tool call. */
export class StdioMcpTransport implements McpTransport {
  private spawn(server: StdioMcpServerConfig, accessToken?: string): ChildProcessWithoutNullStreams {
    const env = { ...process.env };
    if (server.auth) {
      if (!accessToken) throw new Error(`MCP server '${server.name}' requires an access token.`);
      env[server.auth.env] = accessToken;
    }
    return spawn(server.command, server.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env
    });
  }

  async call(
    server: McpServerConfig,
    tool: string,
    argumentsValue: Record<string, unknown>,
    options: McpTransportOptions = {}
  ): Promise<McpToolCallResult> {
    if (server.transport !== "stdio") throw new Error(`MCP server '${server.name}' is not a stdio server.`);
    const process = this.spawn(server, options.accessToken);
    const client = new StdioJsonRpcClient(process, server.name, timeoutFor(server), options.onProcessEvent);
    try {
      await client.request("initialize", initializationParams("stdio"));
      client.notify("notifications/initialized", {});
      return toolResult(
        await client.request("tools/call", { name: tool, arguments: argumentsValue }),
        server,
        tool
      );
    } finally {
      await client.close();
    }
  }

  async verify(server: McpServerConfig, options: McpTransportOptions = {}): Promise<void> {
    if (server.transport !== "stdio") throw new Error(`MCP server '${server.name}' is not a stdio server.`);
    const process = this.spawn(server, options.accessToken);
    const client = new StdioJsonRpcClient(process, server.name, timeoutFor(server), options.onProcessEvent);
    try {
      await client.request("initialize", initializationParams("stdio"));
      client.notify("notifications/initialized", {});
    } finally {
      await client.close();
    }
  }

  async listTools(server: McpServerConfig, options: McpTransportOptions = {}): Promise<McpDiscoveredTool[]> {
    if (server.transport !== "stdio") throw new Error(`MCP server '${server.name}' is not a stdio server.`);
    const process = this.spawn(server, options.accessToken);
    const client = new StdioJsonRpcClient(process, server.name, timeoutFor(server), options.onProcessEvent);
    try {
      await client.request("initialize", initializationParams("stdio"));
      client.notify("notifications/initialized", {});
      return discoveredTools(await client.request("tools/list", {}), server);
    } finally {
      await client.close();
    }
  }
}

class HttpMcpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function jsonRpcResponse(value: unknown, serverName: string, id: number): unknown {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.id !== id) {
    throw new Error(`MCP server '${serverName}' returned an invalid JSON-RPC response.`);
  }
  if (value.error !== undefined) {
    throw new Error(`MCP server '${serverName}' returned a JSON-RPC error.`);
  }
  return value.result;
}

function parseSseMessages(source: string, serverName: string): unknown[] {
  const records: unknown[] = [];
  for (const event of source.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = event.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      records.push(JSON.parse(data));
    } catch {
      throw new Error(`MCP server '${serverName}' sent invalid server-sent events.`);
    }
  }
  return records;
}

async function parseHttpJsonRpcResponse(response: Response, serverName: string, id: number): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await response.text();
  let messages: unknown[];
  if (contentType.includes("text/event-stream")) {
    messages = parseSseMessages(body, serverName);
  } else if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      messages = [JSON.parse(body)];
    } catch {
      throw new Error(`MCP server '${serverName}' returned invalid JSON.`);
    }
  } else {
    throw new Error(`MCP server '${serverName}' returned an unsupported content type.`);
  }
  const message = messages.find((candidate) => isRecord(candidate) && candidate.id === id);
  if (message === undefined) throw new Error(`MCP server '${serverName}' did not return the requested JSON-RPC response.`);
  return jsonRpcResponse(message, serverName, id);
}

class StreamableHttpMcpClient {
  private nextId = 1;
  private sessionId: string | undefined;

  constructor(
    private readonly server: HttpMcpServerConfig,
    private readonly fetchImpl: McpFetch,
    private readonly accessToken: string | undefined
  ) {}

  async initialize(): Promise<void> {
    this.sessionId = undefined;
    await this.request("initialize", initializationParams("http"));
    await this.notify("notifications/initialized", {});
  }

  async call(tool: string, argumentsValue: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.request("tools/call", { name: tool, arguments: argumentsValue });
    } catch (error) {
      if (!(error instanceof HttpMcpStatusError) || error.status !== 404 || !this.sessionId) throw error;
      await this.initialize();
      return this.request("tools/call", { name: tool, arguments: argumentsValue });
    }
  }

  async listTools(): Promise<unknown> {
    return this.request("tools/list", {});
  }

  async terminate(): Promise<void> {
    if (!this.sessionId) return;
    const headers = this.headers();
    headers.set("Mcp-Session-Id", this.sessionId);
    try {
      const response = await this.fetchWithTimeout({ method: "DELETE", headers });
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`MCP server '${this.server.name}' refused a redirect.`);
      }
      if (!response.ok && response.status !== 404) {
        throw new Error(`MCP server '${this.server.name}' could not terminate its session.`);
      }
    } finally {
      this.sessionId = undefined;
    }
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const headers = this.headers();
    headers.set("Content-Type", "application/json");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    const response = await this.fetchWithTimeout({
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });
    this.captureSession(response);
    this.throwForStatus(response);
    return parseHttpJsonRpcResponse(response, this.server.name, id);
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const headers = this.headers();
    headers.set("Content-Type", "application/json");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    const response = await this.fetchWithTimeout({
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params })
    });
    this.captureSession(response);
    this.throwForStatus(response);
  }

  private headers(): Headers {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSIONS.http
    });
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    return headers;
  }

  private captureSession(response: Response): void {
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
  }

  private throwForStatus(response: Response): void {
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`MCP server '${this.server.name}' refused a redirect.`);
    }
    if (!response.ok) {
      throw new HttpMcpStatusError(response.status, `MCP server '${this.server.name}' returned HTTP ${response.status}.`);
    }
  }

  private async fetchWithTimeout(init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutFor(this.server));
    try {
      return await this.fetchImpl(this.server.url, { ...init, redirect: "manual", signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        throw new Error(`MCP server '${this.server.name}' timed out after ${timeoutFor(this.server)}ms.`);
      }
      throw new Error(`MCP server '${this.server.name}' is not available.`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Streamable HTTP MCP transport using the protocol version in the extension manifest. */
export class HttpMcpTransport implements McpTransport {
  constructor(private readonly fetchImpl: McpFetch = (url, init) => fetch(url, init)) {}

  async call(
    server: McpServerConfig,
    tool: string,
    argumentsValue: Record<string, unknown>,
    options: McpTransportOptions = {}
  ): Promise<McpToolCallResult> {
    if (server.transport !== "http") throw new Error(`MCP server '${server.name}' is not an HTTP server.`);
    const client = new StreamableHttpMcpClient(server, this.fetchImpl, options.accessToken);
    try {
      await client.initialize();
      return toolResult(await client.call(tool, argumentsValue), server, tool);
    } finally {
      await client.terminate();
    }
  }

  async verify(server: McpServerConfig, options: McpTransportOptions = {}): Promise<void> {
    if (server.transport !== "http") throw new Error(`MCP server '${server.name}' is not an HTTP server.`);
    const client = new StreamableHttpMcpClient(server, this.fetchImpl, options.accessToken);
    try {
      await client.initialize();
    } finally {
      await client.terminate();
    }
  }

  async listTools(server: McpServerConfig, options: McpTransportOptions = {}): Promise<McpDiscoveredTool[]> {
    if (server.transport !== "http") throw new Error(`MCP server '${server.name}' is not an HTTP server.`);
    const client = new StreamableHttpMcpClient(server, this.fetchImpl, options.accessToken);
    try {
      await client.initialize();
      return discoveredTools(await client.listTools(), server);
    } finally {
      await client.terminate();
    }
  }
}

class DefaultMcpTransport implements McpTransport {
  private readonly stdio = new StdioMcpTransport();
  private readonly http = new HttpMcpTransport();

  call(
    server: McpServerConfig,
    tool: string,
    argumentsValue: Record<string, unknown>,
    options: McpTransportOptions = {}
  ): Promise<McpToolCallResult> {
    return server.transport === "http"
      ? this.http.call(server, tool, argumentsValue, options)
      : this.stdio.call(server, tool, argumentsValue, options);
  }

  verify(server: McpServerConfig, options: McpTransportOptions = {}): Promise<void> {
    return server.transport === "http"
      ? this.http.verify(server, options)
      : this.stdio.verify(server, options);
  }

  listTools(server: McpServerConfig, options: McpTransportOptions = {}): Promise<McpDiscoveredTool[]> {
    return server.transport === "http"
      ? this.http.listTools(server, options)
      : this.stdio.listTools(server, options);
  }
}

/** Registry only accepts explicitly configured server/tool pairs by canonical full name. */
export class McpToolRegistry {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly tools = new Map<string, McpToolConfig>();
  private accessTokenProvider: McpAccessTokenProvider | undefined;
  private readonly rest = new RestMcpAdapter();

  constructor(private readonly transport: McpTransport = new DefaultMcpTransport()) {}

  setAccessTokenProvider(provider: McpAccessTokenProvider | undefined): void {
    this.accessTokenProvider = provider;
  }

  setServers(configurations: readonly unknown[]): string[] {
    this.servers.clear();
    const diagnostics: string[] = [];
    for (const value of configurations) {
      if (!isRecord(value)) {
        diagnostics.push("Each MCP server configuration must be an object.");
        continue;
      }
      const name = value.name;
      if (typeof name !== "string" || !IDENTIFIER.test(name)) {
        diagnostics.push("MCP server names must use letters, numbers, dots, underscores, or hyphens.");
        continue;
      }
      const transport = value.transport;
      if (transport !== "stdio" && transport !== "http") {
        diagnostics.push(`MCP server '${name}' uses unsupported transport '${String(transport)}'.`);
        continue;
      }
      const keysDiagnostic = configurationKeysDiagnostic(
        value,
        transport === "stdio"
          ? ["name", "transport", "command", "args", "auth", "scope", "timeoutMs"]
          : ["name", "transport", "url", "auth", "scope", "timeoutMs"]
      );
      if (keysDiagnostic) {
        diagnostics.push(`MCP server '${name}' ${keysDiagnostic}`);
        continue;
      }
      const timeoutMs = normalizeTimeout(value.timeoutMs, name, diagnostics);
      if (value.timeoutMs !== undefined && timeoutMs === undefined) continue;
      if (this.servers.has(name)) {
        diagnostics.push(`MCP server '${name}' is configured more than once.`);
        continue;
      }
      if (transport === "stdio") {
        if (typeof value.command !== "string" || !value.command.trim()) {
          diagnostics.push(`MCP server '${name}' requires a stdio command.`);
          continue;
        }
        const args = value.args;
        if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))) {
          diagnostics.push(`MCP server '${name}' args must be strings.`);
          continue;
        }
        const stdioAuth = stdioAuthDiagnostic(value.auth);
        if (stdioAuth) {
          diagnostics.push(`MCP server '${name}' ${stdioAuth}`);
          continue;
        }
        const normalizedArgs = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : undefined;
        this.servers.set(name, {
          name,
          transport,
          command: value.command,
          ...(normalizedArgs ? { args: normalizedArgs } : {}),
          ...(isRecord(value.auth) ? { auth: { type: "token", env: value.auth.env as string } } : {}),
          ...(value.scope === "project" || value.scope === "global" ? { scope: value.scope } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {})
        });
        continue;
      }
      const urlDiagnostic = httpUrlDiagnostic(value.url);
      if (urlDiagnostic) {
        diagnostics.push(`MCP server '${name}' ${urlDiagnostic}`);
        continue;
      }
      const configuredAuth = authDiagnostic(value.auth);
      if (configuredAuth) {
        diagnostics.push(`MCP server '${name}' ${configuredAuth}`);
        continue;
      }
      this.servers.set(name, {
        name,
        transport,
        url: value.url as string,
        ...(value.auth !== undefined ? { auth: { type: "bearer" as const } } : {}),
        ...(value.scope === "project" || value.scope === "global" ? { scope: value.scope } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {})
      });
    }
    return diagnostics;
  }

  setTools(configurations: readonly McpToolConfig[]): string[] {
    this.tools.clear();
    const diagnostics: string[] = [];
    for (const config of configurations) {
      if (!IDENTIFIER.test(config.server) || !IDENTIFIER.test(config.tool)) {
        diagnostics.push("MCP tool server and tool names must use letters, numbers, dots, underscores, or hyphens.");
        continue;
      }
      if (!this.servers.has(config.server)) {
        diagnostics.push(`MCP tool '${config.server}.${config.tool}' references unknown server '${config.server}'.`);
        continue;
      }
      const key = `${config.server}.${config.tool}`;
      const existing = this.tools.get(key);
      if (existing) {
        if (existing.server === config.server && existing.tool === config.tool) {
          diagnostics.push(`MCP tool '${key}' is configured more than once.`);
        } else {
          diagnostics.push(`MCP tool name '${key}' collides between server '${existing.server}' tool '${existing.tool}' and server '${config.server}' tool '${config.tool}'.`);
        }
        continue;
      }
      this.tools.set(key, {
        server: config.server,
        tool: config.tool,
        ...(config.kind ? { kind: config.kind } : {}),
        ...(config.method ? { method: config.method } : {}),
        ...(config.url ? { url: config.url } : {}),
        ...(config.docsUrl ? { docsUrl: config.docsUrl } : {}),
        ...(config.description ? { description: config.description } : {}),
        ...(config.inputSchema ? { inputSchema: config.inputSchema } : {}),
        ...(config.outputSchema ? { outputSchema: config.outputSchema } : {})
      });
    }
    return diagnostics;
  }

  list(): McpToolConfig[] {
    return [...this.tools.values()].sort((left, right) => `${left.server}.${left.tool}`.localeCompare(`${right.server}.${right.tool}`));
  }

  listServers(): McpServerConfig[] {
    return [...this.servers.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  getServer(name: string): McpServerConfig | undefined {
    return this.servers.get(name);
  }

  async call(
    tool: string,
    input: Record<string, unknown>,
    options: Pick<McpTransportOptions, "onProcessEvent"> = {}
  ): Promise<McpRawResult> {
    const definition = this.tools.get(tool);
    if (!definition) throw new Error(`MCP tool '${tool}' is not registered in dext.mcpTools.`);
    const configuredServer = this.servers.get(definition.server);
    if (!configuredServer) throw new Error(`MCP server '${definition.server}' is not configured.`);
    const transportOptions = {
      ...await this.transportOptions(configuredServer),
      ...options
    };
    const result = definition.kind === "rest"
      ? await this.rest.call(definition, input, transportOptions.accessToken)
      : await this.transport.call(configuredServer, definition.tool, input, transportOptions);
    return {
      kind: "mcpRaw",
      server: definition.server,
      tool: definition.tool,
      ...(result.content !== undefined ? { content: result.content } : {}),
      ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {})
    };
  }

  async verifyServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) throw new Error(`MCP server '${name}' is not configured.`);
    if (!this.transport.verify) throw new Error("MCP transport verification is not available.");
    await this.transport.verify(server, await this.transportOptions(server));
  }

  /** Queries a configured server so callers can populate the explicit tool allowlist. */
  async discoverServerTools(name: string): Promise<McpDiscoveredTool[]> {
    const server = this.servers.get(name);
    if (!server) throw new Error(`MCP server '${name}' is not configured.`);
    if (!this.transport.listTools) throw new Error("MCP tool discovery is not available.");
    return this.transport.listTools(server, await this.transportOptions(server));
  }

  /** Discover tools for a not-yet-persisted server configuration. */
  async discoverTools(server: McpServerConfig): Promise<McpDiscoveredTool[]> {
    if (!this.transport.listTools) throw new Error("MCP tool discovery is not available.");
    return this.transport.listTools(server, await this.transportOptions(server));
  }

  private async transportOptions(server: McpServerConfig): Promise<McpTransportOptions> {
    if (!server.auth) return {};
    const accessToken = await this.accessTokenProvider?.(server);
    if (!accessToken) {
      throw new Error(`MCP server '${server.name}' requires an access token. Run 'Dext: Set MCP Access Token'.`);
    }
    return { accessToken };
  }
}
