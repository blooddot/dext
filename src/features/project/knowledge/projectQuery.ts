import { z } from "zod";
import type { ProjectModel } from "../contracts/projectModel.js";

export const projectQuerySchema = z.object({
  operation: z.enum(["summary", "node", "search", "neighbors", "ancestors", "subtree"]),
  id: z.string().optional(), text: z.string().max(1000).optional(),
  depth: z.number().int().min(0).max(8).default(1), limit: z.number().int().min(1).max(200).default(50)
}).strict();
export type ProjectQuery = z.input<typeof projectQuerySchema>;

export function queryProject(model: ProjectModel, input: ProjectQuery) {
  const query = projectQuerySchema.parse(input);
  if (query.operation === "summary") return { revision: model.revision, nodes: model.nodes.slice(0, query.limit), relations: [], truncated: model.nodes.length > query.limit };
  if (query.operation === "search") {
    const text = (query.text ?? "").toLowerCase();
    const matches = model.nodes.filter(node => [node.id, node.title, node.canonicalName].some(value => value.toLowerCase().includes(text)));
    return { revision: model.revision, nodes: matches.slice(0, query.limit), relations: [], truncated: matches.length > query.limit };
  }
  if (!query.id || !model.nodes.some(node => node.id === query.id)) throw new Error("Project node not found.");
  const selected = new Set([query.id]); let frontier = [query.id]; let truncated = false;
  if (query.operation !== "node") for (let depth = 0; depth < query.depth; depth++) {
    const next: string[] = [];
    for (const edge of model.relations) {
      if ((query.operation === "ancestors" || query.operation === "subtree") && edge.kind !== "contains") continue;
      const candidates = query.operation === "ancestors" ? frontier.includes(edge.to) ? [edge.from] : []
        : query.operation === "subtree" ? frontier.includes(edge.from) ? [edge.to] : []
        : [ ...(frontier.includes(edge.from) ? [edge.to] : []), ...(frontier.includes(edge.to) ? [edge.from] : []) ];
      for (const id of candidates) if (!selected.has(id)) {
        if (selected.size >= query.limit) { truncated = true; continue; }
        selected.add(id); next.push(id);
      }
    }
    frontier = next; if (!frontier.length) break;
  }
  const relations = model.relations.filter(edge => selected.has(edge.from) && selected.has(edge.to));
  return { revision: model.revision, nodes: model.nodes.filter(node => selected.has(node.id)), relations: relations.slice(0, query.limit * 4), truncated: truncated || relations.length > query.limit * 4 };
}
