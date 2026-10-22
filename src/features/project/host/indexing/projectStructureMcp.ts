/**
 * A tiny stdio MCP server over the persisted structure index. It is deliberately read-only and
 * stateless: each tools/call re-reads the cache, so a project-model rebuild is visible without
 * restarting the server. It never reads source text; the agent follows returned paths itself.
 *
 * The extension injects this file into Codex, Claude and DeepSeek Harness conversations as a
 * host-owned stdio MCP server. No user manifest is required: Dext supplies the command, cache path
 * and `ELECTRON_RUN_AS_NODE` environment to the provider for that conversation only.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";
import { PROJECT_STRUCTURE_VERSION, structureSummarySchema, type StructureSummary } from "./projectStructure.js";
import { buildStructureGraphFromSummary } from "./projectStructureGraph.js";
import {
STRUCTURE_QUERY_DESCRIPTION,
STRUCTURE_QUERY_INPUT_SCHEMA,
STRUCTURE_QUERY_TOOL,
parseStructureQuery,
runStructureQuery
} from "./projectStructureQuery.js";

const cacheSchema = z.object({
  version: z.literal(PROJECT_STRUCTURE_VERSION),
  updatedAt: z.number().optional(),
  summary: structureSummarySchema
});

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const cachePath = argument("--cache");

interface LoadedIndex {
  graph: ReturnType<typeof buildStructureGraphFromSummary>;
  updatedAt?: number;
  files: number;
  modules: number;
  parsed: number;
}

async function loadIndex(): Promise<LoadedIndex> {
  if (!cachePath) throw new Error("The structure server was started without --cache.");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(cachePath, "utf8")); }
  catch { throw new Error("No completed structure index was found. Build or update the project model in Dext first."); }
  const parsed = cacheSchema.safeParse(raw);
  if (!parsed.success) throw new Error("The structure index cache is missing, stale or from an incompatible Dext version. Rebuild the project model.");
  return {
    graph: buildStructureGraphFromSummary(parsed.data.summary as unknown as StructureSummary),
    ...(parsed.data.updatedAt !== undefined ? { updatedAt: parsed.data.updatedAt } : {}),
    files: parsed.data.summary.files, modules: parsed.data.summary.modules.length, parsed: parsed.data.summary.parsed
  };
}

interface JsonRpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcMessage["id"], value: unknown): void {
  send({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function failure(id: JsonRpcMessage["id"], code: number, message: string): void {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function callTool(input: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const index = await loadIndex();
    const query = parseStructureQuery(input);
    const value = { index: { updatedAt: index.updatedAt ?? null, ageMs: index.updatedAt === undefined ? null : Date.now() - index.updatedAt,
      files: index.files, parsed: index.parsed, modules: index.modules }, ...runStructureQuery(index.graph, query) };
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
}

async function handle(message: JsonRpcMessage): Promise<void> {
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "dext-structure-index", version: "1.0.0" },
      instructions: "Query the static import graph before reading files. It proves code dependencies, not runtime calls."
    });
    return;
  }
  if (message.method === "ping") { result(message.id, {}); return; }
  if (message.method === "tools/list") {
    result(message.id, { tools: [{ name: STRUCTURE_QUERY_TOOL, description: STRUCTURE_QUERY_DESCRIPTION, inputSchema: STRUCTURE_QUERY_INPUT_SCHEMA }] });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name !== STRUCTURE_QUERY_TOOL) { failure(message.id, -32602, `Unknown tool '${String(name)}'.`); return; }
    result(message.id, await callTool(message.params?.arguments ?? {}));
    return;
  }
  failure(message.id, -32601, `Unsupported method '${String(message.method)}'.`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
lines.on("line", line => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    let message: JsonRpcMessage;
    try { message = JSON.parse(line) as JsonRpcMessage; }
    catch { failure(null, -32700, "Invalid JSON."); return; }
    if (!message || typeof message !== "object") { failure(null, -32600, "Invalid request."); return; }
    await handle(message);
  }).catch(error => failure(null, -32603, error instanceof Error ? error.message : String(error)));
});
lines.on("close", () => { void queue.finally(() => { process.exitCode = 0; }); });
