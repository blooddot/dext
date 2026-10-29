import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { z } from "zod";
import { parseProjectModel } from "../../knowledge/projectModel.js";
import { projectQuerySchema, queryProject } from "../../knowledge/projectQuery.js";
import type { ProjectModel } from "../../contracts/projectModel.js";

export const PROJECT_QUERY_TOOL = "project_query";
export const PROJECT_QUERY_DESCRIPTION = "Read maintained Project norms and explicit relationships. Does not initialize, scan sources or modify Project. Partial results do not prove no impact.";

export function runProjectQuery(model: ProjectModel, input: unknown): unknown {
  const result = queryProject(model, projectQuerySchema.parse(input));
  let chars = 0; const nodes = [];
  for (const node of result.nodes) {
    const size = JSON.stringify(node).length;
    if (size + chars > 60_000) { result.truncated = true; break; }
    nodes.push(node); chars += size;
  }
  const ids = new Set(nodes.map(node => node.id)); const relations = [];
  for (const edge of result.relations) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    const size = JSON.stringify(edge).length;
    if (size + chars > 60_000) { result.truncated = true; break; }
    relations.push(edge); chars += size;
  }
  return { ...result, nodes, relations };
}

export async function readProjectQuery(modelPath: string, input: unknown): Promise<unknown> {
  if ((await stat(modelPath)).size > 16 * 1024 * 1024) throw new Error("Project model exceeds query read budget.");
  const raw = await readFile(modelPath, "utf8");
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("Project model exceeds query read budget.");
  return runProjectQuery(parseProjectModel(JSON.parse(raw)), input);
}

export function startProjectModelMcp(modelPath: string): void {
  const input = createInterface({ input: process.stdin });
  const send = (id: unknown, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  input.on("line", line => {
    if (line.length > 64_000) return;
    void (async () => {
      const message = JSON.parse(line) as { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
      if (message.id === undefined) return;
      if (message.method === "initialize") { send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "dext-project", version: "1" } }); return; }
      if (message.method === "tools/list") { send(message.id, { tools: [{ name: PROJECT_QUERY_TOOL, description: PROJECT_QUERY_DESCRIPTION, inputSchema: z.toJSONSchema(projectQuerySchema) }] }); return; }
      if (message.method === "ping") { send(message.id, {}); return; }
      if (message.method !== "tools/call" || message.params?.name !== PROJECT_QUERY_TOOL) { send(message.id, { isError: true, content: [{ type: "text", text: "Unknown Project tool." }] }); return; }
      try { send(message.id, { content: [{ type: "text", text: JSON.stringify(await readProjectQuery(modelPath, message.params.arguments)) }] }); }
      catch (error) { send(message.id, { isError: true, content: [{ type: "text", text: String(error) }] }); }
    })().catch(() => { /* Malformed transport input never starts another operation. */ });
  });
}
const flag = process.argv.indexOf("--model");
if (flag >= 0 && process.argv[flag + 1]) startProjectModelMcp(process.argv[flag + 1]!);
