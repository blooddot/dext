import {
structureConsumerEdges,
structureDependencyEdges,
structureAdjacency,
type StructureGraph,
type StructureGraphEdge,
type StructureProvenance
} from "./projectStructureGraph.js";

/**
 * A read-only query surface over one derived structure graph. It never reads source text and never
 * writes: a caller (the Project MCP server, or a future in-process tool) decides where the graph
 * comes from. Every result is bounded and carries provenance on edges.
 */
export type StructureQuery =
  | { op: "node"; path: string }
  | { op: "neighbors"; path: string; direction?: "in" | "out" | "both"; limit?: number }
  | { op: "consumers"; path: string; limit?: number }
  | { op: "dependencies"; path: string; limit?: number }
  | { op: "community"; path: string; limit?: number }
  | { op: "hubs"; limit?: number }
  | { op: "search"; query: string; limit?: number }
  | { op: "path"; from: string; to: string; maxDepth?: number };

export interface StructureQueryEdge {
  from: string;
  to: string;
  kind: StructureGraphEdge["kind"];
  provenance: StructureProvenance;
  typeOnly: boolean;
  count: number;
}

export interface StructureQueryNode {
  path: string;
  module: string;
  language: string;
  rank: number;
  consumers: number;
  crossModuleOut: number;
  community?: string;
}

export interface StructureQueryResult {
  query: StructureQuery;
  nodes: StructureQueryNode[];
  edges: StructureQueryEdge[];
  paths?: string[];
  truncated: boolean;
  /** The graph is a static-import view; it does not prove runtime calls. */
  note: string;
}

const QUERY_NOTE = "Static import graph only: a resolved edge proves a code dependency, not a runtime call, transport or execution order.";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Local path validation so the query server does not need the AI generation module. */
export function isStructurePath(path: string): boolean {
  if (!path.trim() || /^[\\/]|^[A-Za-z]:|:/.test(path) || path.includes("\\")) return false;
  if ([...path].some(character => character.charCodeAt(0) < 32)) return false;
  return !path.split("/").some(part => !part || part === "." || part === "..");
}

function boundedLimit(value: number | undefined): number {
  return Number.isInteger(value) && value! > 0 ? Math.min(value!, MAX_LIMIT) : DEFAULT_LIMIT;
}

function edgeOf(edge: StructureGraphEdge): StructureQueryEdge {
  return { from: edge.from, to: edge.to, kind: edge.kind, provenance: edge.provenance, typeOnly: edge.typeOnly, count: edge.count };
}

function nodeOf(graph: StructureGraph, path: string, communityOf: ReadonlyMap<string, string>): StructureQueryNode | undefined {
  const node = graph.nodes.find(candidate => candidate.path === path);
  return node ? { path: node.path, module: node.module, language: node.language, rank: node.rank,
    consumers: node.consumers, crossModuleOut: node.crossModuleOut, ...(communityOf.has(path) ? { community: communityOf.get(path)! } : {}) } : undefined;
}

/**
 * Validated, bounded query execution. A query that names a file outside the index returns no node
 * and no edge rather than guessing; the caller can then search for the path.
 */
export function runStructureQuery(graph: StructureGraph, query: StructureQuery): StructureQueryResult {
  const communityOf = new Map<string, string>();
  for (const community of graph.communities) for (const path of community.files) communityOf.set(path, community.id);
  const empty = (truncated = false): StructureQueryResult => ({ query, nodes: [], edges: [], truncated, note: QUERY_NOTE });

  if (query.op === "node") {
    if (!isStructurePath(query.path)) return empty();
    const node = nodeOf(graph, query.path, communityOf);
    return { query, nodes: node ? [node] : [], edges: [], truncated: false, note: QUERY_NOTE };
  }
  if (query.op === "neighbors") {
    if (!isStructurePath(query.path)) return empty();
    const direction = query.direction ?? "both";
    const edges = [...(direction !== "in" ? structureDependencyEdges(graph, query.path) : []),
      ...(direction !== "out" ? structureConsumerEdges(graph, query.path) : [])];
    const unique = new Map(edges.map(edge => [JSON.stringify([edge.from, edge.to, edge.kind, edge.typeOnly, edge.provenance]), edge]));
    const ordered = [...unique.values()].sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
    const limit = boundedLimit(query.limit);
    const nodePaths = new Set(ordered.flatMap(edge => [edge.from, edge.to]));
    return { query, nodes: [...nodePaths].sort().flatMap(path => nodeOf(graph, path, communityOf) ?? []),
      edges: ordered.slice(0, limit).map(edgeOf), truncated: ordered.length > limit, note: QUERY_NOTE };
  }
  if (query.op === "consumers" || query.op === "dependencies") {
    if (!isStructurePath(query.path)) return empty();
    const edges = (query.op === "consumers" ? structureConsumerEdges(graph, query.path) : structureDependencyEdges(graph, query.path))
      .slice().sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
    const limit = boundedLimit(query.limit);
    return { query, nodes: [], edges: edges.slice(0, limit).map(edgeOf), truncated: edges.length > limit, note: QUERY_NOTE };
  }
  if (query.op === "community") {
    if (!isStructurePath(query.path)) return empty();
    const id = communityOf.get(query.path);
    if (!id) return empty();
    const community = graph.communities.find(item => item.id === id)!;
    const limit = boundedLimit(query.limit);
    return { query, nodes: community.files.slice(0, limit).flatMap(path => nodeOf(graph, path, communityOf) ?? []), edges: [],
      paths: community.files.slice(0, limit), truncated: community.files.length > limit, note: QUERY_NOTE };
  }
  if (query.op === "hubs") {
    const limit = boundedLimit(query.limit);
    return { query, nodes: graph.hubs.slice(0, limit).flatMap(hub => nodeOf(graph, hub.id, communityOf) ?? []), edges: [],
      truncated: graph.hubs.length > limit, note: QUERY_NOTE };
  }
  if (query.op === "search") {
    const needle = query.query.trim().toLowerCase();
    if (!needle) return empty();
    const limit = boundedLimit(query.limit);
    const matches = graph.nodes.filter(node => node.path.toLowerCase().includes(needle)).sort((left, right) => left.path.localeCompare(right.path));
    return { query, nodes: matches.slice(0, limit).map(node => nodeOf(graph, node.path, communityOf)!).filter(Boolean),
      edges: [], truncated: matches.length > limit, note: QUERY_NOTE };
  }

  if (!isStructurePath(query.from) || !isStructurePath(query.to)) return empty();
  const maxDepth = Number.isInteger(query.maxDepth) && query.maxDepth! > 0 ? Math.min(query.maxDepth!, 12) : 6;
  const previous = new Map<string, string>();
  const queue = [query.from];
  const seen = new Set([query.from]);
  while (queue.length && seen.size <= 500) {
    const current = queue.shift()!;
    if (current === query.to) break;
    const depth = (() => { let steps = 0, cursor = current; while (previous.has(cursor)) { cursor = previous.get(cursor)!; steps++; } return steps; })();
    if (depth >= maxDepth) continue;
    for (const edge of structureDependencyEdges(graph, current)) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to); previous.set(edge.to, current); queue.push(edge.to);
    }
  }
  if (!seen.has(query.to)) return empty();
  const paths: string[] = [];
  for (let cursor: string | undefined = query.to; cursor !== undefined; cursor = previous.get(cursor)) {
    paths.unshift(cursor);
    if (cursor === query.from) break;
  }
  return { query, nodes: paths.flatMap(path => nodeOf(graph, path, communityOf) ?? []), edges: [], paths, truncated: false, note: QUERY_NOTE };
}

/** The MCP tool contract and its JSON schema, kept next to the implementation it describes. */
export const STRUCTURE_QUERY_TOOL = "structure_query";
export const STRUCTURE_QUERY_DESCRIPTION = "Query the project's derived static-import graph. Use it to find a file's indexed consumers/dependencies, the hubs of the codebase, a community around a file, or a short dependency path. Results contain workspace-relative paths and provenance; read a returned path for runtime behavior. This graph never proves a runtime call.";
export const STRUCTURE_QUERY_INPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["op"],
  properties: {
    op: { type: "string", enum: ["node", "neighbors", "consumers", "dependencies", "community", "hubs", "search", "path"] },
    path: { type: "string", description: "Workspace-relative file path." },
    direction: { type: "string", enum: ["in", "out", "both"], description: "neighbors only; defaults to both." },
    query: { type: "string", description: "Case-insensitive substring for search." },
    from: { type: "string", description: "path operation start file." },
    to: { type: "string", description: "path operation end file." },
    maxDepth: { type: "integer", minimum: 1, maximum: 12, description: "path operation bound; defaults to 6." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum returned nodes/edges; defaults to 50." }
  }
};

/** One validation entry point shared by the MCP server and any in-process caller. */
export function parseStructureQuery(value: unknown): StructureQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Structure query must be an object.");
  const input = value as Record<string, unknown>;
  const string = (key: string, required = false): string | undefined => {
    const candidate = input[key];
    if (candidate === undefined && !required) return undefined;
    if (typeof candidate !== "string" || !candidate.trim()) throw new Error(`'${key}' must be a non-empty string.`);
    return candidate;
  };
  const integer = (key: string): number | undefined => {
    const candidate = input[key];
    if (candidate === undefined) return undefined;
    if (!Number.isInteger(candidate) || (candidate as number) < 1 || (candidate as number) > 200) throw new Error(`'${key}' must be an integer between 1 and 200.`);
    return candidate as number;
  };
  switch (input.op) {
    case "node": return { op: "node", path: string("path", true)! };
    case "neighbors": {
      const direction = input.direction;
      if (direction !== undefined && direction !== "in" && direction !== "out" && direction !== "both") throw new Error("'direction' must be in, out or both.");
      return { op: "neighbors", path: string("path", true)!, ...(direction ? { direction } : {}), ...(integer("limit") !== undefined ? { limit: integer("limit")! } : {}) };
    }
    case "consumers": return { op: "consumers", path: string("path", true)!, ...(integer("limit") !== undefined ? { limit: integer("limit")! } : {}) };
    case "dependencies": return { op: "dependencies", path: string("path", true)!, ...(integer("limit") !== undefined ? { limit: integer("limit")! } : {}) };
    case "community": return { op: "community", path: string("path", true)!, ...(integer("limit") !== undefined ? { limit: integer("limit")! } : {}) };
    case "hubs": return { op: "hubs", ...(integer("limit") !== undefined ? { limit: integer("limit")! } : {}) };
    case "search": return { op: "search", query: string("query", true)!, ...(integer("limit") !== undefined ? { limit: integer("limit")! } : {}) };
    case "path": return { op: "path", from: string("from", true)!, to: string("to", true)!, ...(integer("maxDepth") !== undefined ? { maxDepth: integer("maxDepth")! } : {}) };
    default: throw new Error("Unsupported structure query operation.");
  }
}

/** All edges around one path, with the deduplicated graph view a tool should return. */
export function queryEdges(graph: StructureGraph, path: string): StructureQueryEdge[] {
  const { outgoing, incoming } = structureAdjacency(graph);
  return [...(outgoing.get(path) ?? []), ...(incoming.get(path) ?? [])]
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)).map(edgeOf);
}
