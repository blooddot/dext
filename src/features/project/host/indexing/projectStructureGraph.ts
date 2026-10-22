import { createHash } from "node:crypto";
import type { StructureIndex, StructureMember, StructureSummary } from "./projectStructure.js";

/**
 * The derived graph of one structure index. It is never persisted: every field can be recomputed
 * from cached file facts, which keeps the cache schema and the index version independent of the
 * graph queries added here. Node ids are workspace-relative file paths.
 */
export type StructureProvenance = "extracted" | "inferred" | "ambiguous";

export interface StructureGraphNode {
  id: string;
  path: string;
  /** Physical module id from the structure summary, not an AI responsibility. */
  module: string;
  language: string;
  /** PageRank over resolved file imports. Ranking only; never a correctness score. */
  rank: number;
  /** Distinct non-type importers. */
  consumers: number;
  /** Distinct modules this file imports, excluding its own module. */
  crossModuleOut: number;
}

export interface StructureGraphEdge {
  from: string;
  to: string;
  kind: "import" | "module" | "dynamic";
  /** `extracted` means a static specifier resolved to an indexed file; imports are not runtime calls. */
  provenance: StructureProvenance;
  typeOnly: boolean;
  count: number;
}

export interface StructureCommunity {
  id: string;
  /** Files in deterministic path order. */
  files: string[];
  modules: string[];
  /** Internal edge weight divided by all incident edge weight; 1 for an isolated file. */
  cohesion: number;
}

export interface StructureGraph {
  version: 1;
  nodes: StructureGraphNode[];
  edges: StructureGraphEdge[];
  communities: StructureCommunity[];
  /** Strongly connected components with more than one file, deterministic order. */
  cycles: string[][];
  /** Highest PageRank files with at least one edge. */
  hubs: Array<{ id: string; score: number }>;
  truncated: { edges: number; communities: number; cycles: number };
}

export const STRUCTURE_GRAPH_EDGE_LIMIT = 20_000;
export const STRUCTURE_GRAPH_CYCLE_LIMIT = 50;
export const STRUCTURE_GRAPH_COMMUNITY_LIMIT = 5_000;

interface FileFact { path: string; language: string; hash?: string }
interface EdgeFact { from: string; to: string; kind: StructureGraphEdge["kind"]; provenance: StructureProvenance; typeOnly: boolean }

const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * PageRank over the file graph. The structure summary uses the same function to order candidates,
 * so there is one ranking contract rather than a second implementation in the graph layer.
 */
export function rankStructureFiles(paths: readonly string[], edges: readonly { from: string; to?: string }[]): Map<string, number> {
  const ordered = [...new Set(paths)].sort();
  const outgoing = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.to) continue;
    const targets = outgoing.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    outgoing.set(edge.from, targets);
  }
  const count = Math.max(1, ordered.length);
  let ranks = new Map(ordered.map(path => [path, 1 / count]));
  for (let iteration = 0; iteration < 12; iteration++) {
    const dangling = ordered.reduce((sum, path) => sum + (outgoing.get(path)?.size ? 0 : ranks.get(path)!), 0);
    const next = new Map(ordered.map(path => [path, (0.15 + 0.85 * dangling) / count]));
    for (const [from, targets] of outgoing) for (const to of targets) if (next.has(to)) next.set(to, next.get(to)! + 0.85 * ranks.get(from)! / targets.size);
    ranks = next;
  }
  return ranks;
}

function moduleOwners(summary: Pick<StructureSummary, "modules">): Map<string, string> {
  const owners = new Map<string, string>();
  for (const module of summary.modules) for (const member of module.members) owners.set(member.path, module.id);
  return owners;
}

interface GraphInput {
  files: readonly FileFact[];
  owners: ReadonlyMap<string, string>;
  edges: readonly EdgeFact[];
}

function aggregateEdges(edges: readonly EdgeFact[]): { edges: StructureGraphEdge[]; truncated: number } {
  const grouped = new Map<string, StructureGraphEdge>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const key = JSON.stringify([edge.from, edge.to, edge.kind, edge.provenance, edge.typeOnly]);
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { from: edge.from, to: edge.to, kind: edge.kind, provenance: edge.provenance, typeOnly: edge.typeOnly, count: 1 });
  }
  const sorted = [...grouped.values()].sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
    || left.kind.localeCompare(right.kind) || Number(left.typeOnly) - Number(right.typeOnly) || left.provenance.localeCompare(right.provenance));
  return { edges: sorted.slice(0, STRUCTURE_GRAPH_EDGE_LIMIT), truncated: Math.max(0, sorted.length - STRUCTURE_GRAPH_EDGE_LIMIT) };
}

/** Iterative Kosaraju, so a deep import chain cannot overflow the call stack. */
function stronglyConnected(nodeIds: readonly string[], edges: readonly StructureGraphEdge[]): string[][] {
  const adjacency = new Map<string, string[]>(nodeIds.map(id => [id, []]));
  const reverse = new Map<string, string[]>(nodeIds.map(id => [id, []]));
  for (const edge of edges) {
    if (edge.typeOnly) continue;
    adjacency.get(edge.from)?.push(edge.to);
    reverse.get(edge.to)?.push(edge.from);
  }
  for (const list of adjacency.values()) list.sort();
  for (const list of reverse.values()) list.sort();
  const seen = new Set<string>();
  const order: string[] = [];
  for (const start of nodeIds) {
    if (seen.has(start)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    seen.add(start);
    while (stack.length) {
      const frame = stack.at(-1)!;
      const children = adjacency.get(frame.id) ?? [];
      if (frame.next < children.length) {
        const child = children[frame.next++]!;
        if (!seen.has(child)) { seen.add(child); stack.push({ id: child, next: 0 }); }
      } else {
        order.push(frame.id);
        stack.pop();
      }
    }
  }
  const assigned = new Set<string>();
  const components: string[][] = [];
  for (let index = order.length - 1; index >= 0; index--) {
    const start = order[index]!;
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length) {
      const id = stack.pop()!;
      component.push(id);
      for (const child of reverse.get(id) ?? []) if (!assigned.has(child)) { assigned.add(child); stack.push(child); }
    }
    if (component.length > 1) components.push(component.sort());
  }
  components.sort((left, right) => left[0]!.localeCompare(right[0]!));
  return components;
}

/** Deterministic local moving with aggregation; type-only edges never join communities. */
function detectCommunities(nodeIds: readonly string[], edges: readonly StructureGraphEdge[]): { communities: Map<string, string[]>; truncated: number } {
  const adjacency = new Map<string, Map<string, number>>(nodeIds.map(id => [id, new Map<string, number>()]));
  for (const edge of edges) {
    if (edge.typeOnly || edge.provenance === "ambiguous") continue;
    const forward = adjacency.get(edge.from);
    const backward = adjacency.get(edge.to);
    if (!forward || !backward || edge.from === edge.to) continue;
    forward.set(edge.to, (forward.get(edge.to) ?? 0) + edge.count);
    backward.set(edge.from, (backward.get(edge.from) ?? 0) + edge.count);
  }
  const degree = new Map(nodeIds.map(id => [id, [...(adjacency.get(id)?.values() ?? [])].reduce((sum, value) => sum + value, 0)]));
  const totalWeight = [...degree.values()].reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) return { communities: new Map(nodeIds.map(id => [`community:${digest(id)}`, [id]])), truncated: 0 };

  let graphNodes = [...nodeIds].sort();
  let graphEdges = new Map<string, Map<string, number>>(graphNodes.map(id => [id, new Map(adjacency.get(id) ?? [])]));
  let graphDegree = new Map(graphNodes.map(id => [id, degree.get(id) ?? 0]));
  // Composed partition from supernodes back to original files.
  let partition = new Map(nodeIds.map(id => [id, id]));

  for (let round = 0; round < 12; round++) {
    const community = new Map(graphNodes.map(id => [id, id]));
    const totals = new Map(graphNodes.map(id => [id, graphDegree.get(id) ?? 0]));
    const twoM = [...graphDegree.values()].reduce((sum, value) => sum + value, 0) || 1;
    let movedAny = false;
    for (let iteration = 0; iteration < 20; iteration++) {
      let moved = false;
      for (const node of graphNodes) {
        const current = community.get(node)!;
        const nodeDegree = graphDegree.get(node) ?? 0;
        totals.set(current, (totals.get(current) ?? 0) - nodeDegree);
        const weights = new Map<string, number>();
        for (const [neighbor, weight] of graphEdges.get(node) ?? []) {
          if (neighbor === node) continue;
          const label = community.get(neighbor)!;
          weights.set(label, (weights.get(label) ?? 0) + weight);
        }
        const gain = (label: string): number => (weights.get(label) ?? 0) - nodeDegree * (totals.get(label) ?? 0) / twoM;
        let best = current, bestGain = gain(current);
        for (const label of [...weights.keys()].sort()) {
          const candidate = gain(label);
          if (candidate > bestGain + 1e-12 || (Math.abs(candidate - bestGain) <= 1e-12 && label < best)) { best = label; bestGain = candidate; }
        }
        totals.set(best, (totals.get(best) ?? 0) + nodeDegree);
        community.set(node, best);
        if (best !== current) { moved = true; movedAny = true; }
      }
      if (!moved) break;
    }
    // Compose this round's supernode partition into the original assignment.
    partition = new Map([...partition].map(([original, supernode]) => [original, community.get(supernode) ?? supernode]));
    if (!movedAny) break;
    const groups = new Map<string, string[]>();
    for (const node of graphNodes) {
      const label = community.get(node)!;
      groups.set(label, [...(groups.get(label) ?? []), node]);
    }
    if (groups.size === graphNodes.length) break;
    const orderedGroups = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
    const aggregated = new Map<string, Map<string, number>>();
    for (const [label] of orderedGroups) aggregated.set(label, new Map());
    for (const [from, targets] of graphEdges) {
      const left = community.get(from)!;
      for (const [to, weight] of targets) {
        const right = community.get(to)!;
        if (left === right) continue;
        const row = aggregated.get(left)!;
        row.set(right, (row.get(right) ?? 0) + weight);
      }
    }
    graphNodes = orderedGroups.map(([label]) => label);
    graphEdges = new Map(graphNodes.map(id => [id, new Map([...(aggregated.get(id) ?? [])].filter(([target]) => aggregated.has(target)))]));
    graphDegree = new Map(graphNodes.map(id => [id, [...(graphEdges.get(id)?.values() ?? [])].reduce((sum, value) => sum + value, 0)]));
  }

  const byLabel = new Map<string, string[]>();
  for (const node of nodeIds) {
    const label = partition.get(node) ?? node;
    byLabel.set(label, [...(byLabel.get(label) ?? []), node]);
  }
  const communities = new Map<string, string[]>();
  for (const files of byLabel.values()) {
    const sorted = files.sort();
    communities.set(`community:${digest(sorted.join("\n"))}`, sorted);
  }
  const ordered = [...communities.entries()].sort(([left], [right]) => left.localeCompare(right));
  return { communities: new Map(ordered.slice(0, STRUCTURE_GRAPH_COMMUNITY_LIMIT)), truncated: Math.max(0, ordered.length - STRUCTURE_GRAPH_COMMUNITY_LIMIT) };
}
function buildGraph(input: GraphInput): StructureGraph {
  const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path));
  const paths = files.map(file => file.path);
  const available = new Set(paths);
  const graphEdges = input.edges.filter(edge => available.has(edge.from) && available.has(edge.to));
  const ranks = rankStructureFiles(paths, graphEdges.map(edge => ({ from: edge.from, to: edge.to })));
  const { edges, truncated } = aggregateEdges(graphEdges);
  const consumers = new Map<string, Set<string>>();
  const crossModule = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.typeOnly) continue;
    const consumersOfTarget = consumers.get(edge.to) ?? new Set<string>();
    consumersOfTarget.add(edge.from);
    consumers.set(edge.to, consumersOfTarget);
    const targetModule = input.owners.get(edge.to), ownModule = input.owners.get(edge.from);
    if (targetModule && ownModule && targetModule !== ownModule) {
      const modules = crossModule.get(edge.from) ?? new Set<string>();
      modules.add(targetModule);
      crossModule.set(edge.from, modules);
    }
  }
  const nodes: StructureGraphNode[] = files.map(file => ({
    id: file.path, path: file.path, module: input.owners.get(file.path) ?? "module:.",
    language: file.language, rank: ranks.get(file.path) ?? 0,
    consumers: consumers.get(file.path)?.size ?? 0,
    crossModuleOut: crossModule.get(file.path)?.size ?? 0
  }));
  const cycles = stronglyConnected(paths, edges);
  const communities = detectCommunities(paths, edges);
  const moduleByPath = new Map(nodes.map(node => [node.path, node.module]));
  return {
    version: 1, nodes, edges,
    communities: [...communities.communities.entries()].map(([id, communityFiles]) => ({
      id, files: communityFiles,
      modules: [...new Set(communityFiles.map(path => moduleByPath.get(path) ?? "module:."))].sort(),
      cohesion: cohesionOf(communityFiles, edges)
    })),
    cycles: cycles.slice(0, STRUCTURE_GRAPH_CYCLE_LIMIT),
    hubs: nodes.filter(node => node.consumers > 0 || node.crossModuleOut > 0)
      .sort((left, right) => right.rank - left.rank || left.path.localeCompare(right.path))
      .slice(0, 20).map(node => ({ id: node.id, score: node.rank })),
    truncated: { edges: truncated, communities: communities.truncated, cycles: Math.max(0, cycles.length - STRUCTURE_GRAPH_CYCLE_LIMIT) }
  };
}

function cohesionOf(files: readonly string[], edges: readonly StructureGraphEdge[]): number {
  const members = new Set(files);
  let internal = 0, incident = 0;
  for (const edge of edges) {
    if (edge.typeOnly) continue;
    const inside = members.has(edge.from) && members.has(edge.to);
    if (inside) internal += edge.count;
    if (members.has(edge.from) || members.has(edge.to)) incident += edge.count;
  }
  return incident ? internal / incident : 1;
}

export function buildStructureGraph(index: Pick<StructureIndex, "cache" | "dependencies" | "summary">): StructureGraph {
  const edges: EdgeFact[] = index.dependencies.flatMap(edge => edge.to ? [{
    from: edge.from, to: edge.to, kind: edge.kind,
    provenance: edge.kind === "dynamic" || edge.to === undefined ? "ambiguous" as const : "extracted" as const,
    typeOnly: edge.typeOnly === true
  }] : []);
  return buildGraph({ files: index.cache.files, owners: moduleOwners(index.summary), edges });
}

/** Rebuild the graph from cached module facts, without re-reading or re-parsing a source file. */
export function buildStructureGraphFromSummary(summary: StructureSummary): StructureGraph {
  const edges: EdgeFact[] = summary.modules.flatMap(module => module.members).flatMap((member: StructureMember) => member.dependencies.flatMap(edge => edge.to ? [{
    from: member.path, to: edge.to, kind: "import" as const,
    provenance: "extracted" as const, typeOnly: edge.typeOnly === true
  }] : []));
  return buildGraph({ files: summary.modules.flatMap(module => module.members), owners: moduleOwners(summary), edges });
}

/** Build a graph from a bare member list; callers that have no package grouping still get one contract. */
export function buildStructureGraphFromMembers(files: readonly StructureMember[]): StructureGraph {
  const owners = new Map(files.map(file => {
    const separator = file.path.lastIndexOf("/");
    return [file.path, `module:${separator < 0 ? "." : file.path.slice(0, separator)}`] as const;
  }));
  const edges: EdgeFact[] = files.flatMap(member => member.dependencies.flatMap(edge => edge.to ? [{
    from: member.path, to: edge.to, kind: "import" as const,
    provenance: "extracted" as const, typeOnly: edge.typeOnly === true
  }] : []));
  return buildGraph({ files, owners, edges });
}

export interface StructureAdjacency {
  outgoing: Map<string, StructureGraphEdge[]>;
  incoming: Map<string, StructureGraphEdge[]>;
}
const adjacencyCache = new WeakMap<StructureGraph, StructureAdjacency>();

export function structureAdjacency(graph: StructureGraph): StructureAdjacency {
  const cached = adjacencyCache.get(graph);
  if (cached) return cached;
  const outgoing = new Map<string, StructureGraphEdge[]>(), incoming = new Map<string, StructureGraphEdge[]>();
  for (const edge of graph.edges) {
    const out = outgoing.get(edge.from) ?? []; out.push(edge); outgoing.set(edge.from, out);
    const into = incoming.get(edge.to) ?? []; into.push(edge); incoming.set(edge.to, into);
  }
  const result = { outgoing, incoming };
  adjacencyCache.set(graph, result);
  return result;
}

export interface StructureEdgeOptions { typeOnly?: boolean }

export function structureDependencyEdges(graph: StructureGraph, path: string, options: StructureEdgeOptions = {}): StructureGraphEdge[] {
  return (structureAdjacency(graph).outgoing.get(path) ?? []).filter(edge => options.typeOnly === undefined || edge.typeOnly === options.typeOnly);
}

export function structureConsumerEdges(graph: StructureGraph, path: string, options: StructureEdgeOptions = {}): StructureGraphEdge[] {
  return (structureAdjacency(graph).incoming.get(path) ?? []).filter(edge => options.typeOnly === undefined || edge.typeOnly === options.typeOnly);
}

export function structureConsumers(graph: StructureGraph, path: string, options: StructureEdgeOptions = {}): string[] {
  return [...new Set(structureConsumerEdges(graph, path, options).map(edge => edge.from))].sort();
}

export function structureDependencies(graph: StructureGraph, path: string, options: StructureEdgeOptions = {}): string[] {
  return [...new Set(structureDependencyEdges(graph, path, options).map(edge => edge.to))].sort();
}

export function structureNeighborPaths(graph: StructureGraph, paths: Iterable<string>, options: StructureEdgeOptions = {}): Set<string> {
  const neighbors = new Set<string>();
  for (const path of paths) {
    for (const target of structureDependencies(graph, path, options)) neighbors.add(target);
    for (const source of structureConsumers(graph, path, options)) neighbors.add(source);
  }
  return neighbors;
}

/**
 * The small, deterministic subset of the graph handed to a bounded evidence read and to diagram
 * generation. Edges always stay inside the supplied candidate paths, so prompt growth is bounded by
 * the evidence window rather than by repository size.
 */
export interface StructureGraphFacts {
  version: 1;
  edges: Array<{ from: string; to: string; kind: StructureGraphEdge["kind"]; provenance: StructureProvenance; typeOnly: boolean }>;
  hubs: Array<{ id: string; score: number }>;
  truncated: { edges: number };
}

export const STRUCTURE_GRAPH_FACT_EDGE_LIMIT = 200;

export function structureGraphFacts(graph: StructureGraph, paths: Iterable<string>): StructureGraphFacts {
  const candidates = new Set(paths);
  const eligible = graph.edges.filter(edge => !edge.typeOnly && edge.provenance !== "ambiguous" && candidates.has(edge.from) && candidates.has(edge.to));
  const rank = new Map(graph.nodes.map(node => [node.path, node.rank]));
  const score = (edge: StructureGraphEdge): number => (rank.get(edge.from) ?? 0) + (rank.get(edge.to) ?? 0) + Math.min(edge.count, 10) / 1000;
  const ordered = [...eligible].sort((left, right) => score(right) - score(left) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return {
    version: 1,
    edges: ordered.slice(0, STRUCTURE_GRAPH_FACT_EDGE_LIMIT).map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind, provenance: edge.provenance, typeOnly: edge.typeOnly })),
    hubs: graph.hubs.filter(hub => candidates.has(hub.id)).slice(0, 20).map(hub => ({ id: hub.id, score: hub.score })),
    truncated: { edges: Math.max(0, ordered.length - STRUCTURE_GRAPH_FACT_EDGE_LIMIT) }
  };
}

/** Bounded breadth-first dependency walk used for browser build entries. */
export function structureEntryFamily(graph: StructureGraph, entry: string, maxFiles = 24, maxDepth = 3): string[] {
  const seen = new Set<string>();
  const queue: Array<{ path: string; depth: number }> = [{ path: entry, depth: 0 }];
  while (queue.length && seen.size < maxFiles) {
    const next = queue.shift()!;
    if (seen.has(next.path)) continue;
    seen.add(next.path);
    if (next.depth < maxDepth) for (const target of structureDependencies(graph, next.path, { typeOnly: false })) queue.push({ path: target, depth: next.depth + 1 });
  }
  return [...seen];
}

export function structureEntryPaths(graph: StructureGraph, entry: string, isBoundary: (path: string) => boolean, maxFiles = 24, maxDepth = 3): string[] {
  return structureEntryFamily(graph, entry, maxFiles, maxDepth).filter(path => path === entry || isBoundary(path));
}
