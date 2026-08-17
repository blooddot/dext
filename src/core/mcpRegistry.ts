import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpRawResult } from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface McpServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface McpToolConfig {
  server: string;
  tool: string;
  description?: string;
}

export interface McpToolCallResult {
  content?: string;
  structuredContent?: Record<string, unknown>;
}

/** A transport boundary keeps registry tests independent from real MCP servers. */
export interface McpTransport {
  call(server: McpServerConfig, tool: string, argumentsValue: Record<string, unknown>): Promise<McpToolCallResult>;
}

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

class StdioJsonRpcClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly exited: Promise<void>;

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    private readonly serverName: string,
    private readonly timeoutMs: number
  ) {
    this.exited = new Promise((resolve) => this.process.once("exit", () => resolve()));
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => this.consume(chunk));
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

  private consumeLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.failPending(`MCP server '${this.serverName}' sent invalid JSON-RPC.`);
      return;
    }
    if (!isRecord(message) || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
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
  async call(server: McpServerConfig, tool: string, argumentsValue: Record<string, unknown>): Promise<McpToolCallResult> {
    const process: ChildProcessWithoutNullStreams = spawn(server.command, server.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
    const client = new StdioJsonRpcClient(process, server.name, timeoutFor(server));
    try {
      await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "dext", version: "0.1.0" }
      });
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
}

/** Registry only accepts explicitly configured server/tool pairs by canonical full name. */
export class McpToolRegistry {
  private readonly servers = new Map<string, McpServerConfig>();
  private readonly tools = new Map<string, McpToolConfig>();

  constructor(private readonly transport: McpTransport = new StdioMcpTransport()) {}

  setServers(configurations: readonly McpServerConfig[]): string[] {
    this.servers.clear();
    const diagnostics: string[] = [];
    for (const config of configurations) {
      if (!IDENTIFIER.test(config.name)) {
        diagnostics.push("MCP server names must use letters, numbers, dots, underscores, or hyphens.");
        continue;
      }
      if (config.transport !== "stdio") {
        diagnostics.push(`MCP server '${config.name}' uses unsupported transport '${String(config.transport)}'.`);
        continue;
      }
      if (typeof config.command !== "string" || !config.command.trim()) {
        diagnostics.push(`MCP server '${config.name}' requires a stdio command.`);
        continue;
      }
      if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string"))) {
        diagnostics.push(`MCP server '${config.name}' args must be strings.`);
        continue;
      }
      if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 120_000)) {
        diagnostics.push(`MCP server '${config.name}' timeoutMs must be an integer from 1000 to 120000.`);
        continue;
      }
      if (this.servers.has(config.name)) {
        diagnostics.push(`MCP server '${config.name}' is configured more than once.`);
        continue;
      }
      this.servers.set(config.name, {
        name: config.name,
        transport: "stdio",
        command: config.command,
        ...(config.args ? { args: [...config.args] } : {}),
        ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {})
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
        ...(config.description ? { description: config.description } : {})
      });
    }
    return diagnostics;
  }

  list(): McpToolConfig[] {
    return [...this.tools.values()].sort((left, right) => `${left.server}.${left.tool}`.localeCompare(`${right.server}.${right.tool}`));
  }

  async call(tool: string, input: Record<string, unknown>): Promise<McpRawResult> {
    const definition = this.tools.get(tool);
    if (!definition) throw new Error(`MCP tool '${tool}' is not registered in dext.mcpTools.`);
    const configuredServer = this.servers.get(definition.server);
    if (!configuredServer) throw new Error(`MCP server '${definition.server}' is not configured.`);
    const result = await this.transport.call(configuredServer, definition.tool, input);
    return {
      kind: "mcpRaw",
      server: definition.server,
      tool: definition.tool,
      ...(result.content !== undefined ? { content: result.content } : {}),
      ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {})
    };
  }
}
