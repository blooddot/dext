import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DiagramValidationIssue,
  DiagramValidationReceipt,
  ProjectDiagram,
  ProjectDiagramEvidence,
  ProjectDiagramKind,
  ProjectDiagramNode,
  ProjectDiagramRelation
} from "./projectDiagram.js";
import type {
  DiagramAdapterArtifact,
  DiagramAdapterCapability,
  DiagramAdapterDocument,
  DiagramAdapterExportOptions,
  DiagramAdapterRenderOptions,
  ProjectDiagramAdapter
} from "./projectDiagramAdapter.js";
import { assertDiagramDocument, diagramArtifact, diagramReceipt, readDiagramOutput, runDiagramProcess, withDiagramFiles } from "./projectDiagramProcess.js";

const KINDS = ["architecture", "workflow", "sequence", "data_flow", "lifecycle"] as const;
const RUNTIME_VERSION = "2.17.0-dev.1+d673e830";
const PACKAGE_VERSION = "2.17.0-dev.1";
const LOCALE = "zh-CN";
const MAX_LAYOUT_REPAIRS = 2;
const ASSET_CHECKS: readonly { path: string; label: string }[] = [
  { path: "bin/archify.mjs", label: "CLI" },
  { path: "assets/template.html", label: "HTML template" },
  { path: "renderers/architecture/render-architecture.mjs", label: "architecture renderer" },
  { path: "renderers/workflow/render-workflow.mjs", label: "workflow renderer" },
  { path: "renderers/sequence/render-sequence.mjs", label: "sequence renderer" },
  { path: "renderers/dataflow/render-dataflow.mjs", label: "dataflow renderer" },
  { path: "renderers/lifecycle/render-lifecycle.mjs", label: "lifecycle renderer" },
  { path: "schemas/architecture.schema.json", label: "architecture schema" },
  { path: "schemas/workflow.schema.json", label: "workflow schema" },
  { path: "schemas/sequence.schema.json", label: "sequence schema" },
  { path: "schemas/dataflow.schema.json", label: "dataflow schema" },
  { path: "schemas/lifecycle.schema.json", label: "lifecycle schema" },
  { path: "LICENSE", label: "license" },
  { path: "THIRD_PARTY_NOTICES.md", label: "third-party notices" }
];

export interface ArchifyRepository {
  /** Workspace root used to verify source evidence against the pinned revision. */
  root: string;
  url: string;
  revision: string;
  provider?: "github" | "gitee";
}

/** Project id to Archify id and back. The mapping never leaves the adapter document. */
export interface ArchifyIdMapping {
  ids: Record<string, string>;
  reverseIds: Record<string, string>;
  relationIds: Record<string, string>;
  reverseRelationIds: Record<string, string>;
}

interface ArchifyDocument {
  project: ProjectDiagram;
  ir: Record<string, unknown>;
  mapping: ArchifyIdMapping;
  repository?: ArchifyRepository;
  /** False after a bounded repair dropped repository source evidence. */
  evidenceAttached: boolean;
}

interface UpstreamDiagnostic {
  code?: string;
  severity?: string;
  message?: string;
  subject?: { path?: string; collection?: string; index?: number; id?: string; identity?: string };
}

interface UpstreamResult {
  ok?: boolean;
  error?: string;
  diagnostics?: UpstreamDiagnostic[];
  composition?: { status?: string; summary?: { errors?: number; warnings?: number }; issues?: unknown[] };
}

export class ArchifyLayoutError extends Error {
  constructor(message: string, readonly diagnostics: readonly string[]) { super(message); this.name = "ArchifyLayoutError"; }
}

const KIND_LABELS: Record<string, string> = {
  calls: "calls", returns: "returns", depends_on: "depends on", contains: "contains", reads: "reads", writes: "writes",
  publishes: "publishes", subscribes: "subscribes", transitions: "transitions", flows_to: "flows to", unknown: "related"
};

/** CJK-aware text width estimate used only for layout hints, never for semantic decisions. */
function labelWidth(label: string, perUnit = 7): number {
  let units = 0;
  for (const character of label) units += character.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return Math.round(units * perUnit);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

function archifyId(value: string, used: Set<string>): string {
  const base = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const prefixed = /^[A-Za-z]/.test(base) ? base : `n-${base || "item"}`;
  let candidate = prefixed || "item";
  let suffix = 2;
  while (used.has(candidate)) candidate = `${prefixed}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

/** Maps semantic Project roles to the upstream component kinds instead of treating every node alike. */
function componentType(node: ProjectDiagramNode): string {
  switch (node.role) {
    case "actor": return "external";
    case "store": return "database";
    case "event": return "messagebus";
    case "unknown": return "backend";
    default: return "backend";
  }
}

function relationLabel(relation: ProjectDiagramRelation): string {
  return relation.label ?? KIND_LABELS[relation.kind] ?? relation.kind;
}

function evidenceSources(node: ProjectDiagramNode, repository: ArchifyRepository | undefined, attached: boolean): readonly { path: string; line?: number; label?: string }[] | undefined {
  if (!repository || !attached) return undefined;
  const entries = node.evidence
    .filter((entry: ProjectDiagramEvidence) => entry.path)
    .slice(0, 3)
    .map((entry) => ({ path: entry.path, ...(entry.line ? { line: entry.line } : {}), ...(entry.note ? { label: truncate(entry.note, 48) } : {}) }));
  return entries.length ? entries : undefined;
}

function metadataRepository(repository: ArchifyRepository | undefined, attached: boolean): Record<string, unknown> | undefined {
  if (!repository || !attached) return undefined;
  return {
    url: repository.url,
    revision: repository.revision,
    link_mode: "local-only" as const,
    ...(repository.provider ? { provider: repository.provider } : {})
  };
}

/** Receipt cache bound. Each key embeds the full IR JSON, so an unbounded map would
 * grow with every distinct edit of every diagram in one session. */
const MAX_CACHED_RECEIPTS = 32;

function cacheReceipt(cache: Map<string, DiagramValidationReceipt>, key: string, receipt: DiagramValidationReceipt): void {
  cache.delete(key);
  cache.set(key, receipt);
  while (cache.size > MAX_CACHED_RECEIPTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Upstream supports repository evidence for architecture diagrams only:
 * `archify validate|deliver|preview --repo-root` is rejected for every other
 * type (`cli/unsupported-option`), and only `architecture.schema.json` declares
 * `meta.repository` or per-node `sources`. Dext therefore attaches repository
 * evidence to that one kind and never passes the flag for the others.
 */
function supportsRepositoryEvidence(kind: string): boolean {
  return kind === "architecture";
}

/** Longest-path rank per node. Explicit relation order is not required for layout, only for meaning. */
function rankNodes(nodes: readonly ProjectDiagramNode[], edges: readonly { from: string; to: string }[]): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) { adjacency.set(node.id, []); indegree.set(node.id, 0); }
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  const ranks = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const remaining = new Map(indegree);
  const processed = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (processed.has(id)) continue;
    processed.add(id);
    for (const next of adjacency.get(id) ?? []) {
      ranks.set(next, Math.max(ranks.get(next) ?? 0, (ranks.get(id) ?? 0) + 1));
      remaining.set(next, (remaining.get(next) ?? 1) - 1);
      if ((remaining.get(next) ?? 0) <= 0) queue.push(next);
    }
  }
  // Cycles are legal (state loops, retry paths): nodes left in a cycle get a stable bounded rank.
  let fallback = 0;
  for (const node of nodes) if (!processed.has(node.id)) { fallback += 1; ranks.set(node.id, Math.max(ranks.get(node.id) ?? 0, fallback)); }
  return ranks;
}

function flowEdges(diagram: ProjectDiagram, kinds?: readonly ProjectDiagramRelation["kind"][]): readonly { from: string; to: string }[] {
  return diagram.relations
    .filter((relation) => !kinds || kinds.includes(relation.kind))
    .map((relation) => ({ from: relation.from, to: relation.to }));
}

function sortedRelations(diagram: ProjectDiagram, ordering?: Readonly<Record<string, number>>): readonly ProjectDiagramRelation[] {
  return [...diagram.relations].sort((left, right) => {
    const leftOrder = ordering?.[left.id] ?? left.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = ordering?.[right.id] ?? right.order ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });
}

interface BuiltIr {
  ir: Record<string, unknown>;
  mapping: ArchifyIdMapping;
}

function emptyMapping(): ArchifyIdMapping {
  return { ids: {}, reverseIds: {}, relationIds: {}, reverseRelationIds: {} };
}

function mapNode(mapping: ArchifyIdMapping, node: ProjectDiagramNode, used: Set<string>): string {
  const id = archifyId(node.id, used);
  mapping.ids[node.id] = id;
  mapping.reverseIds[id] = node.id;
  return id;
}

function mapRelation(mapping: ArchifyIdMapping, relation: ProjectDiagramRelation, used: Set<string>): string {
  const id = archifyId(relation.id || `relation-${relation.from}-${relation.to}`, used);
  mapping.relationIds[relation.id] = id;
  mapping.reverseRelationIds[id] = relation.id;
  return id;
}

function baseMeta(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const repositoryMeta = metadataRepository(repository, attached);
  return {
    title: project.title,
    quality_profile: "standard",
    locale: LOCALE,
    ...(repositoryMeta ? { repository: repositoryMeta } : {}),
    ...extra
  };
}

function buildArchitecture(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const count = Math.max(1, project.nodes.length);
  const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(count))));
  const components = project.nodes.map((node, index) => {
    const id = mapNode(mapping, node, usedNodes);
    const sources = evidenceSources(node, repository, attached);
    return {
      id,
      type: componentType(node),
      label: node.label,
      ...(node.description ? { sublabel: truncate(node.description, 80) } : {}),
      row: Math.floor(index / columns),
      col: index % columns,
      size: [Math.max(220, Math.min(380, labelWidth(node.label) + 48)), 72],
      ...(sources ? { sources } : {})
    };
  });
  const boundaries = (project.semantics?.boundaries ?? []).flatMap((boundary) => {
    const wraps = boundary.nodeIds.map((id) => mapping.ids[id]).filter((id): id is string => Boolean(id));
    return wraps.length ? [{ kind: boundary.kind ?? "region", label: boundary.label, wraps }] : [];
  });
  const connections = project.relations.map((relation) => {
    const id = mapRelation(mapping, relation, usedRelations);
    return {
      id,
      from: mapping.ids[relation.from],
      to: mapping.ids[relation.to],
      label: relationLabel(relation),
      ...(relation.exception ? { variant: "dashed" } : {})
    };
  });
  return {
    mapping,
    ir: {
      schema_version: 1,
      diagram_type: "architecture",
      meta: baseMeta(project, repository, attached),
      layout: { mode: "grid", cols: columns, gapX: 140, gapY: 140 },
      components,
      ...(boundaries.length ? { boundaries } : {}),
      connections
    }
  };
}

function buildWorkflow(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  const semantics = project.semantics ?? {};
  const declaredLanes = semantics.lanes ?? [];
  if (!declaredLanes.length) throw new Error("Workflow diagram is missing evidenced lanes.");
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const usedLanes = new Set<string>();
  const laneById = new Map(declaredLanes.map((lane) => [lane.id, lane]));
  const archifyLaneByProjectLane = new Map<string, string>();
  const lanes: Array<Record<string, unknown>> = [];
  for (const lane of declaredLanes) {
    const id = archifyId(lane.id, usedLanes);
    archifyLaneByProjectLane.set(lane.id, id);
    lanes.push({ id, label: lane.label, variant: lane.variant === "exception" ? "exception" : "normal" });
  }
  const ranks = rankNodes(project.nodes, flowEdges(project));
  const pickLane = (node: ProjectDiagramNode): { lane: string; col: number } => {
    const declared = node.laneId && laneById.has(node.laneId) ? node.laneId : declaredLanes[0]!.id;
    const rank = ranks.get(node.id) ?? 0;
    const band = Math.floor(rank / 6);
    const baseLane = archifyLaneByProjectLane.get(declared)!;
    if (band === 0) return { lane: baseLane, col: rank % 6 };
    const continuationId = `${baseLane}-cont-${band}`;
    if (!usedLanes.has(continuationId)) {
      usedLanes.add(continuationId);
      const source = laneById.get(declared)!;
      lanes.push({ id: continuationId, label: `${source.label} (cont. ${band + 1})`, variant: source.variant === "exception" ? "exception" : "normal" });
    }
    return { lane: continuationId, col: rank % 6 };
  };
  const nodes = project.nodes.map((node) => {
    const id = mapNode(mapping, node, usedNodes);
    const placement = pickLane(node);
    const sources = evidenceSources(node, repository, attached);
    return {
      id,
      lane: placement.lane,
      col: placement.col,
      type: componentType(node),
      label: node.label,
      width: Math.max(92, Math.min(360, labelWidth(node.label) + 24)),
      ...(node.description ? { sublabel: truncate(node.description, 80) } : {}),
      ...(sources ? { sources } : {})
    };
  });
  const edges = project.relations.map((relation) => {
    const id = mapRelation(mapping, relation, usedRelations);
    const role = relation.exception ? "error" : relation.kind === "returns" ? "return" : relation.condition ? "branch" : "main";
    const label = relation.condition ? `${relationLabel(relation)}（${relation.condition}）` : relationLabel(relation);
    return { id, from: mapping.ids[relation.from], to: mapping.ids[relation.to], label, role };
  });
  const phases = (semantics.phases ?? []).flatMap((phase) => {
    const fromCol = Math.max(0, Math.min(5, Math.round(phase.fromCol)));
    const toCol = Math.max(fromCol, Math.min(5, Math.round(phase.toCol)));
    return [{ id: archifyId(phase.id, usedLanes), label: phase.label, fromCol, toCol }];
  });
  const groups = (semantics.groups ?? []).flatMap((group) => {
    const lane = archifyLaneByProjectLane.get(group.laneId);
    if (!lane) return [];
    const fromCol = Math.max(0, Math.min(5, Math.round(group.fromCol)));
    const toCol = Math.max(fromCol, Math.min(5, Math.round(group.toCol)));
    const contains = project.nodes.some((node) => node.laneId === group.laneId && pickLane(node).col >= fromCol && pickLane(node).col <= toCol);
    if (!contains) return [];
    return [{ id: archifyId(group.id, usedLanes), label: group.label, lane, fromCol, toCol }];
  });
  const mappedMainPath = (semantics.mainPath ?? []).map((id) => mapping.ids[id]).filter((id): id is string => Boolean(id));
  // The upstream mainPath lint requires a left-to-right happy path. A folded (>6 step) chain would
  // move backward, so the layout omits it there while Project keeps the semantic path.
  const mainPathIsLinear = mappedMainPath.length >= 2 && mappedMainPath.every((id, index) => {
    if (index === 0) return true;
    const previous = nodes.find((entry) => entry["id"] === mappedMainPath[index - 1]);
    const current = nodes.find((entry) => entry["id"] === id);
    return Boolean(previous && current && previous["lane"] === current["lane"] && Number(current["col"]) > Number(previous["col"]));
  });
  const mainPath = mainPathIsLinear ? mappedMainPath : [];

  return {
    mapping,
    ir: {
      schema_version: 2,
      diagram_type: "workflow",
      meta: baseMeta(project, repository, attached),
      lanes,
      ...(phases.length ? { phases } : {}),
      ...(groups.length ? { groups } : {}),
      ...(mainPath.length >= 2 ? { mainPath } : {}),
      nodes,
      edges
    }
  };
}

function buildSequence(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  const semantics = project.semantics ?? {};
  const participantNodes = [...(semantics.participants ?? [])].sort((left, right) => left.order - right.order);
  if (participantNodes.length < 2) throw new Error("Sequence diagram needs at least two evidenced participants.");
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
  const participants = participantNodes.flatMap((participant) => {
    const node = nodeById.get(participant.nodeId);
    if (!node) return [];
    const id = mapNode(mapping, node, usedNodes);
    const sources = evidenceSources(node, repository, attached);
    return [{
      id,
      type: componentType(node),
      label: node.label,
      ...(node.description ? { sublabel: truncate(node.description, 80) } : {}),
      ...(sources ? { sources } : {})
    }];
  });
  if (participants.length < 2) throw new Error("Sequence diagram participants do not reference existing nodes.");
  const messageOrder = new Map((semantics.messages ?? []).map((message) => [message.relationId, message.order]));
  const ordered = sortedRelations(project, Object.fromEntries(messageOrder));
  const messageKinds = new Map((semantics.messages ?? []).map((message) => [message.relationId, message.kind]));
  const messages = ordered
    .filter((relation) => mapping.ids[relation.from] && mapping.ids[relation.to])
    .map((relation, index) => {
      const id = mapRelation(mapping, relation, usedRelations);
      const kind = messageKinds.get(relation.id);
      return {
        id,
        from: mapping.ids[relation.from],
        to: mapping.ids[relation.to],
        y: 200 + index * 70,
        label: truncate(relationLabel(relation), 120),
        ...(kind === "return" || relation.kind === "returns" ? { variant: "return" } : {}),
        ...(relation.condition ? { note: truncate(relation.condition, 200) } : {})
      };
    });
  const longest = Math.max(0, ...project.nodes.map((node) => node.label.length));
  return {
    mapping,
    ir: {
      schema_version: 1,
      diagram_type: "sequence",
      meta: baseMeta(project, repository, attached, longest > 12 ? { column_fit: "spread" } : {}),
      participants,
      messages
    }
  };
}

function buildDataFlow(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  const semantics = project.semantics ?? {};
  const stages = [...(semantics.stages ?? [])].sort((left, right) => left.order - right.order);
  if (stages.length < 2 || stages.length > 5) throw new Error("Data-flow diagram needs between two and five evidenced processing stages.");
  const stageIndex = new Map(stages.map((stage, index) => [stage.id, index]));
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const rowByStage = new Map<number, number>();
  const nodes = project.nodes.map((node) => {
    const id = mapNode(mapping, node, usedNodes);
    const stage = node.stageId !== undefined ? stageIndex.get(node.stageId) : undefined;
    if (stage === undefined) throw new Error(`Data-flow node '${node.id}' is missing an evidenced processing stage.`);
    const row = rowByStage.get(stage) ?? 0;
    rowByStage.set(stage, row + 1);
    const sources = evidenceSources(node, repository, attached);
    return {
      id,
      type: componentType(node),
      label: node.label,
      ...(node.description ? { sublabel: truncate(node.description, 80) } : {}),
      width: Math.max(140, Math.min(340, labelWidth(node.label) + 32)),
      stage,
      row,
      ...(sources ? { sources } : {})
    };
  });
  const flows = project.relations.map((relation) => {
    const id = mapRelation(mapping, relation, usedRelations);
    const label = relation.condition ? `${relationLabel(relation)}（${relation.condition}）` : relationLabel(relation);
    return {
      id,
      from: mapping.ids[relation.from],
      to: mapping.ids[relation.to],
      label,
      ...(relation.exception ? { variant: "dashed" } : {})
    };
  });
  const viewBoxWidth = Math.max(760, stages.length * 320 + 160);
  const maxRows = Math.max(1, ...[...rowByStage.values()]);
  const viewBoxHeight = Math.max(520, 320 + maxRows * 120);
  return {
    mapping,
    ir: {
      schema_version: 1,
      diagram_type: "dataflow",
      meta: baseMeta(project, repository, attached, { viewBox: [viewBoxWidth, viewBoxHeight] }),
      stages: stages.map((stage) => ({ label: stage.label })),
      nodes,
      flows
    }
  };
}

function lifecycleLaneId(value: string, used: Set<string>): string {
  if (value === "main" || value === "terminal") return value;
  return archifyId(value, used);
}

function stateType(node: ProjectDiagramNode, kind: "initial" | "terminal" | "normal", outcome?: "success" | "failure"): string {
  if (kind === "initial") return "start";
  if (kind === "terminal") return outcome === "failure" ? "failure" : "success";
  if (node.role === "store") return "waiting";
  if (node.role === "actor") return "external";
  if (node.role === "event") return "neutral";
  return "active";
}

function buildLifecycle(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  const semantics = project.semantics ?? {};
  const stateDefinitions = semantics.states ?? [];
  if (!stateDefinitions.length) throw new Error("Lifecycle diagram is missing explicit initial/terminal states.");
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const usedLanes = new Set<string>();
  const stateByNode = new Map(stateDefinitions.map((state) => [state.nodeId, state]));
  const transitionIds = new Set((semantics.transitions ?? []).map((transition) => transition.relationId));
  const transitionRelations = project.relations.filter((relation) => transitionIds.has(relation.id) || relation.kind === "transitions");
  const transitionByRelation = new Map((semantics.transitions ?? []).map((transition) => [transition.relationId, transition]));
  const declaredLanes = semantics.lanes ?? [];
  const mainSource = declaredLanes.find((lane) => lane.id === "main") ?? declaredLanes[0];
  const terminalSource = declaredLanes.find((lane) => lane.id === "terminal");
  const eventSource = declaredLanes.filter((lane) => lane !== mainSource && lane !== terminalSource).slice(0, 2);
  const hasTerminal = stateDefinitions.some((state) => state.kind === "terminal");
  const lanes: Array<Record<string, unknown>> = [{ id: "main", label: mainSource?.label ?? "Stages" }];
  if (hasTerminal) lanes.push({ id: "terminal", label: terminalSource?.label ?? "Result" });
  const eventLaneIds: string[] = [];
  for (const lane of eventSource) {
    const id = lifecycleLaneId(lane.id, usedLanes);
    eventLaneIds.push(id);
    lanes.push({ id, label: lane.label });
  }
  if (eventLaneIds.length === 0 && lanes.length < 4) {
    eventLaneIds.push("events");
    lanes.push({ id: "events", label: "Events" });
  }
  const ranks = rankNodes(project.nodes, transitionRelations.map((relation) => ({ from: relation.from, to: relation.to })));
  // Main rail gets explicit columns in rank order; overflow continues in event bands.
  const mainOrder = [...new Set(project.nodes.map((node) => ranks.get(node.id) ?? 0))].sort((left, right) => left - right);
  const mainColumn = new Map<number, number>();
  const overflowRanks: number[] = [];
  mainOrder.forEach((rank) => { if (mainColumn.size < 5) mainColumn.set(rank, mainColumn.size); else overflowRanks.push(rank); });
  const overflowIndex = new Map(overflowRanks.map((rank, index) => [rank, index]));
  const occupancy = new Map<string, number>();
  const states = project.nodes.map((node) => {
    const id = mapNode(mapping, node, usedNodes);
    const definition = stateByNode.get(node.id);
    const rank = ranks.get(node.id) ?? 0;
    let lane = "main";
    let col = 0;
    if (definition?.kind === "terminal") {
      lane = hasTerminal ? "terminal" : "main";
      const terminalIndex = stateDefinitions.filter((state) => state.kind === "terminal").findIndex((state) => state.nodeId === node.id);
      col = terminalIndex % 3;
      const key = `${lane}:${col}`;
      const count = occupancy.get(key) ?? 0;
      occupancy.set(key, count + 1);
      return {
        id,
        type: stateType(node, definition.kind, definition.outcome),
        label: node.label,
        lane,
        col,
        width: Math.max(118, Math.min(260, labelWidth(node.label) + 36)),
        ...(count ? { yOffset: count * 72 } : {})
      };
    }
    if (definition?.kind === "initial") {
      lane = "main";
      col = mainColumn.get(rank) ?? 0;
    } else if (overflowIndex.has(rank)) {
      const index = overflowIndex.get(rank)!;
      lane = eventLaneIds[Math.floor(index / 3) % Math.max(1, eventLaneIds.length)] ?? "main";
      col = index % 3;
    } else {
      lane = "main";
      col = mainColumn.get(rank) ?? 0;
    }
    const key = `${lane}:${col}`;
    const count = occupancy.get(key) ?? 0;
    occupancy.set(key, count + 1);
    return {
      id,
      type: stateType(node, definition?.kind ?? "normal", definition?.outcome),
      label: node.label,
      lane,
      col,
      width: Math.max(118, Math.min(260, labelWidth(node.label) + 36)),
      ...(count ? { yOffset: count * 72 } : {})
    };
  });
  const transitions = transitionRelations.flatMap((relation) => {
    if (!mapping.ids[relation.from] || !mapping.ids[relation.to]) return [];
    const definition = transitionByRelation.get(relation.id);
    const source = states.find((state) => state.id === mapping.ids[relation.from]);
    const target = states.find((state) => state.id === mapping.ids[relation.to]);
    const id = mapRelation(mapping, relation, usedRelations);
    const label = definition?.event ?? relation.label;
    const note = definition?.condition ?? relation.condition;
    return [{
      id,
      from: mapping.ids[relation.from],
      to: mapping.ids[relation.to],
      ...(label ? { label: truncate(label, 60) } : {}),
      ...(note ? { note: truncate(note, 200) } : {}),
      ...(source?.lane === "main" && target?.lane !== "main" ? { route: "drop" } : {})
    }];
  });
  const maxStack = Math.max(0, ...[...occupancy.values()].map((count) => count - 1));
  const viewBoxHeight = Math.max(660, 566 + maxStack * 72);
  return {
    mapping,
    ir: {
      schema_version: 1,
      diagram_type: "lifecycle",
      meta: baseMeta(project, repository, attached, { viewBox: [980, viewBoxHeight] }),
      lanes,
      states,
      transitions
    }
  };
}

function buildIr(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  switch (project.kind) {
    case "architecture": return buildArchitecture(project, repository, attached);
    case "workflow": return buildWorkflow(project, repository, attached);
    case "sequence": return buildSequence(project, repository, attached);
    case "data_flow": return buildDataFlow(project, repository, attached);
    case "lifecycle": return buildLifecycle(project, repository, attached);
  }
}

function diagnosticLines(result: UpstreamResult): string[] {
  const diagnostics = result.diagnostics ?? [];
  if (diagnostics.length) return diagnostics.map((diagnostic) => diagnostic.message ?? diagnostic.code ?? "Archify diagnostic").slice(0, 12);
  return result.error ? [result.error] : ["Archify reported a validation failure."];
}

function isSemanticDiagnostic(diagnostic: UpstreamDiagnostic): boolean {
  const code = diagnostic.code ?? "";
  if (code.startsWith("schema/") || code.startsWith("repository-evidence/")) return true;
  if (code.startsWith("layout/") || code.startsWith("composition/") || code.startsWith("clean-flow/")) return false;
  return false;
}

function hasRepositoryEvidenceDiagnostic(result: UpstreamResult): boolean {
  return (result.diagnostics ?? []).some((diagnostic) => (diagnostic.code ?? "").startsWith("repository-evidence/"));
}

function diagnosticsToIssues(result: UpstreamResult, mapping: ArchifyIdMapping | undefined, fallback = "Archify validation failed."): DiagramValidationIssue[] {
  const issues: DiagramValidationIssue[] = [];
  for (const diagnostic of result.diagnostics ?? []) {
    const identity = diagnostic.subject?.identity ?? diagnostic.subject?.id;
    const nodeId = identity && mapping?.reverseIds[identity] ? mapping.reverseIds[identity] : undefined;
    const relationId = identity && mapping?.reverseRelationIds[identity] ? mapping.reverseRelationIds[identity] : undefined;
    issues.push({
      code: diagnostic.code ?? "archify_validation",
      message: truncate(diagnostic.message ?? diagnostic.code ?? fallback, 2000),
      severity: diagnostic.severity === "warning" ? "warning" : diagnostic.severity === "info" ? "info" : "error",
      ...(nodeId ? { nodeId } : {}),
      ...(relationId ? { relationId } : {})
    });
  }
  if (!issues.length && result.error) issues.push({ code: "archify_validation", message: truncate(result.error, 2000), severity: "error" });
  if (!issues.length) issues.push({ code: "archify_validation", message: fallback, severity: "error" });
  return issues;
}

function compositionIssues(result: UpstreamResult): DiagramValidationIssue[] {
  const issues: DiagramValidationIssue[] = [];
  for (const entry of (result.composition?.issues ?? []).slice(0, 40)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const message = typeof record["message"] === "string" ? record["message"] : JSON.stringify(record);
    issues.push({
      code: typeof record["code"] === "string" ? record["code"] : "archify_composition",
      message: truncate(message, 2000),
      severity: record["severity"] === "warning" ? "warning" : "info"
    });
  }
  const warnings = result.composition?.summary?.warnings ?? 0;
  if (!issues.length && warnings > 0) issues.push({ code: "archify_composition", message: `${warnings} upstream composition warning(s).`, severity: "warning" });
  return issues;
}

function validationVerdict(result: UpstreamResult): "passed" | "warning" | "failed-semantic" | "failed-layout" {
  if (result.ok) return (result.composition?.summary?.warnings ?? 0) > 0 ? "warning" : "passed";
  const diagnostics = result.diagnostics ?? [];
  if (!diagnostics.length) return "failed-layout";
  return diagnostics.every(isSemanticDiagnostic) ? "failed-semantic" : "failed-layout";
}

/** Bounded layout-only repair. Semantic errors are never rewritten. */
function repairIr(input: Record<string, unknown>, diagnostics: readonly string[], attempt: number): Record<string, unknown> {
  const ir = structuredClone(input);
  const text = diagnostics.join("\n").toLowerCase();
  const type = typeof ir["diagram_type"] === "string" ? ir["diagram_type"] : "";
  if (type === "architecture") {
    const components = Array.isArray(ir["components"]) ? ir["components"] as Record<string, unknown>[] : [];
    const previousCols = typeof (ir["layout"] as Record<string, unknown> | undefined)?.["cols"] === "number"
      ? Number((ir["layout"] as Record<string, unknown>)["cols"]) : 3;
    const cols = attempt <= 1 ? Math.max(1, Math.min(3, previousCols)) : Math.max(1, previousCols - 1);
    ir["layout"] = { mode: "grid", cols, gapX: 140 + attempt * 60, gapY: 140 + attempt * 60 };
    ir["components"] = components.map((component, index) => {
      const next: Record<string, unknown> = { ...component, row: Math.floor(index / cols), col: index % cols };
      delete next["pos"];
      return next;
    });
  }
  if (type === "workflow") {
    // Groups and phases are presentation containers: drop them before touching semantic edges.
    if (text.includes("group") || text.includes("phase") || text.includes("column")) { delete ir["groups"]; delete ir["phases"]; }
    if (text.includes("moves backward")) delete ir["mainPath"];
    const nodes = Array.isArray(ir["nodes"]) ? ir["nodes"] as Record<string, unknown>[] : [];
    ir["nodes"] = nodes.map((node) => ({
      ...node,
      col: Math.max(0, Math.min(5, Math.round(Number(node["col"] ?? 0)))),
      ...(text.includes("wider than node") ? { width: Math.max(Number(node["width"] ?? 92), 200 + attempt * 60) } : {})
    }));
    if (text.includes("viewbox") || text.includes("containment")) {
      const meta = { ...(ir["meta"] as Record<string, unknown> ?? {}) };
      const current = Array.isArray(meta["viewBox"]) ? meta["viewBox"] as number[] : undefined;
      meta["viewBox"] = [Math.max(980, current?.[0] ?? 0), Math.max(420, (current?.[1] ?? 320) + attempt * 140)];
      ir["meta"] = meta;
    }
  }
  if (type === "sequence") {
    const messages = Array.isArray(ir["messages"]) ? ir["messages"] as Record<string, unknown>[] : [];
    ir["messages"] = messages.map((message, index) => ({ ...message, y: 200 + index * (70 + attempt * 45) }));
    const meta = { ...(ir["meta"] as Record<string, unknown> ?? {}), column_fit: "spread" };
    ir["meta"] = meta;
  }
  if (type === "dataflow") {
    const meta = { ...(ir["meta"] as Record<string, unknown> ?? {}) };
    const current = Array.isArray(meta["viewBox"]) ? meta["viewBox"] as number[] : [900, 520];
    meta["viewBox"] = [Math.max(760, current[0] ?? 0), Math.max(420, (current[1] ?? 520) + attempt * 120)];
    ir["meta"] = meta;
  }
  if (type === "lifecycle") {
    const transitions = Array.isArray(ir["transitions"]) ? ir["transitions"] as Record<string, unknown>[] : [];
    const states = Array.isArray(ir["states"]) ? ir["states"] as Record<string, unknown>[] : [];
    if (text.includes("label") && (text.includes("overlap") || text.includes("collid"))) {
      ir["transitions"] = transitions.map((transition) => { const next = { ...transition }; delete next["label"]; return next; });
    }
    if (text.includes("less than 10px") || text.includes("overlap")) {
      ir["states"] = states.map((state) => ({ ...state, ...(typeof state["yOffset"] === "number" ? { yOffset: Number(state["yOffset"]) + attempt * 36 } : {}) }));
    }
    if (text.includes("wider than")) {
      ir["states"] = states.map((state) => ({ ...state, width: Math.max(Number(state["width"] ?? 118), 180 + attempt * 40) }));
    }
    if (text.includes("too short") || text.includes("endpoint-side") || text.includes("edge-through-node")) {
      ir["transitions"] = transitions.map((transition) => ({ ...transition, route: typeof transition["route"] === "string" ? transition["route"] : "drop" }));
    }
    const meta = { ...(ir["meta"] as Record<string, unknown> ?? {}) };
    const current = Array.isArray(meta["viewBox"]) ? meta["viewBox"] as number[] : [980, 660];
    meta["viewBox"] = [Math.max(980, current[0] ?? 0), Math.min(1600, Math.max(660, (current[1] ?? 660) + attempt * 120))];
    ir["meta"] = meta;
  }
  return ir;
}

export class ArchifyAdapter implements ProjectDiagramAdapter {
  readonly id = "archify";
  readonly version = RUNTIME_VERSION;
  readonly capabilities: readonly DiagramAdapterCapability[] = KINDS.map((kind) => ({
    kind,
    formats: ["html", "svg"] as const,
    features: ["interactive", "deterministic", "validation", "path_probe", "evidence_links"] as const
  }));
  private readonly active = new Map<string, AbortController>();
  private readonly lastReceipts = new Map<string, DiagramValidationReceipt>();
  private disposed = false;

  /**
   * @param runtimeRoot absolute Archify directory supplied by the extension host (`context.extensionUri`).
   * @param repository optional pinned repository metadata used for source evidence in architecture diagrams.
   */
  private repositoryValue: ArchifyRepository | undefined;
  private repositoryResolved: Promise<ArchifyRepository | undefined> | undefined;

  /**
   * @param runtimeRoot absolute Archify directory supplied by the extension host (context.extensionUri).
   * @param repository pinned repository metadata, or a lazy provider used for architecture evidence.
   */
  constructor(
    private readonly runtimeRoot: string,
    private readonly repository?: ArchifyRepository | (() => Promise<ArchifyRepository | undefined>)
  ) {}

  private async resolveRepository(): Promise<ArchifyRepository | undefined> {
    if (typeof this.repository !== "function") return this.repository;
    if (!this.repositoryResolved) {
      this.repositoryResolved = this.repository().then((value) => { this.repositoryValue = value; return value; }, () => undefined);
    }
    return this.repositoryValue ?? this.repositoryResolved;
  }

  supports(kind: ProjectDiagramKind): boolean {
    return (KINDS as readonly string[]).includes(kind);
  }

  async probe(): Promise<{ available: boolean; reason?: string }> {
    try {
      const pkg = JSON.parse(await readFile(join(this.runtimeRoot, "package.json"), "utf8")) as { version?: string };
      if (pkg.version !== PACKAGE_VERSION) return { available: false, reason: `Unsupported Archify runtime version ${pkg.version ?? "unknown"}.` };
      for (const check of ASSET_CHECKS) {
        try { await access(join(this.runtimeRoot, check.path)); }
        catch { return { available: false, reason: `Archify runtime is missing its ${check.label}.` }; }
      }
      return { available: true };
    } catch {
      return { available: false, reason: "Archify runtime is unavailable." };
    }
  }

  async transform(project: ProjectDiagram, signal?: AbortSignal): Promise<DiagramAdapterDocument> {
    if (this.disposed || signal?.aborted) throw new Error("Diagram operation cancelled.");
    const receipt = diagramReceipt(project, this.id, this.version);
    if (receipt.status === "failed") throw new Error(receipt.issues.map((issue) => issue.message).join("; "));
    const resolved = await this.resolveRepository();
    const repository = resolved && supportsRepositoryEvidence(project.kind) ? resolved : undefined;
    const built = buildIr(project, repository, Boolean(repository));
    const payload: ArchifyDocument = {
      project,
      ir: built.ir,
      mapping: built.mapping,
      ...(repository ? { repository } : {}),
      evidenceAttached: Boolean(repository)
    };
    return { adapterId: this.id, adapterVersion: this.version, diagramId: project.id, kind: project.kind, payload };
  }

  private async invokeValidate(ir: Record<string, unknown>, signal?: AbortSignal): Promise<UpstreamResult> {
    const type = String(ir["diagram_type"]);
    const repository = await this.resolveRepository();
    // The document can outlive the kind that produced it, so the flag is gated here too.
    const repoArgs = repository && supportsRepositoryEvidence(type) ? ["--repo-root", repository.root] : [];
    const text = await withDiagramFiles(ir, (directory, input) =>
      runDiagramProcess(process.execPath, [join(this.runtimeRoot, "bin/archify.mjs"), "validate", type, input, "--json", ...repoArgs], directory, signal, { tolerateFailure: true }), "json");
    try { return JSON.parse(text) as UpstreamResult; }
    catch { throw new Error(`Archify validate returned invalid JSON diagnostics: ${text.slice(0, 600)}`); }
  }

  private async invokeDeliver(ir: Record<string, unknown>, signal?: AbortSignal): Promise<{ result: UpstreamResult; html?: string }> {
    const type = String(ir["diagram_type"]);
    const repository = await this.resolveRepository();
    const repoArgs = repository && supportsRepositoryEvidence(type) ? ["--repo-root", repository.root] : [];
    return withDiagramFiles(ir, async (directory, input, output) => {
      const text = await runDiagramProcess(process.execPath, [join(this.runtimeRoot, "bin/archify.mjs"), "deliver", type, input, output, "--json", ...repoArgs], directory, signal, { tolerateFailure: true });
      let result: UpstreamResult;
      // A failed CLI writes its diagnostics to the stream the process layer returned;
      // surface that text instead of a bare SyntaxError from JSON.parse.
      try { result = JSON.parse(text) as UpstreamResult; }
      catch { throw new Error(`Archify deliver returned invalid JSON diagnostics: ${text.slice(0, 600)}`); }
      return result.ok ? { result, html: await readDiagramOutput(output) } : { result };
    }, "html");
  }

  private receiptFrom(result: UpstreamResult, mapping: ArchifyIdMapping | undefined, repairs: number): DiagramValidationReceipt {
    const verdict = validationVerdict(result);
    return {
      adapterId: this.id,
      adapterVersion: this.version,
      status: verdict === "passed" ? "passed" : verdict === "warning" ? "warning" : "failed",
      checkedAt: Date.now(),
      issues: verdict === "failed-semantic" || verdict === "failed-layout"
        ? diagnosticsToIssues(result, mapping)
        : compositionIssues(result),
      metadata: {
        runtime: this.version,
        repairs,
        upstream: JSON.stringify({ ok: result.ok === true, checks: result.composition?.summary ?? {}, error: result.error ?? "" }).slice(0, 12000)
      }
    };
  }

  async validate(document: DiagramAdapterDocument, signal?: AbortSignal): Promise<DiagramValidationReceipt> {
    assertDiagramDocument(document, this.id, this.version, signal ? { signal } : undefined);
    const payload = document.payload as ArchifyDocument;
    const signature = JSON.stringify(payload.ir);
    const cached = this.lastReceipts.get(`${document.diagramId}:${signature}`);
    if (cached) return structuredClone(cached);
    const available = await this.probe();
    if (!available.available) throw new Error(available.reason);
    const result = await this.invokeValidate(payload.ir, signal);
    const receipt = this.receiptFrom(result, payload.mapping, 0);
    if (receipt.status !== "failed") cacheReceipt(this.lastReceipts, `${document.diagramId}:${signature}`, receipt);
    return structuredClone(receipt);
  }

  preview(document: DiagramAdapterDocument, options: DiagramAdapterRenderOptions = {}): Promise<DiagramAdapterArtifact> {
    return this.render(document, { ...options, format: "html" });
  }

  async render(document: DiagramAdapterDocument, options: DiagramAdapterRenderOptions = {}): Promise<DiagramAdapterArtifact> {
    assertDiagramDocument(document, this.id, this.version, options);
    const format = options.format ?? "html";
    if (format === "svg") throw new Error("Archify SVG export uses the rendered viewer result; render HTML and export from the viewer.");
    if (this.disposed) throw new Error("Archify adapter disposed.");
    const available = await this.probe();
    if (!available.available) throw new Error(available.reason);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const operationId = options.operationId ?? document.diagramId;
    this.active.get(operationId)?.abort();
    this.active.set(operationId, controller);
    const payload = document.payload as ArchifyDocument;
    let ir = payload.ir;
    const diagnostics: string[] = [];
    try {
      for (let attempt = 0; attempt <= MAX_LAYOUT_REPAIRS; attempt += 1) {
        if (controller.signal.aborted) throw new Error("Diagram operation cancelled.");
        const validation = await this.invokeValidate(ir, controller.signal).catch((error) => {
          if (controller.signal.aborted) throw new Error("Diagram operation cancelled.");
          throw error;
        });
        const verdict = validationVerdict(validation);
        if (verdict === "failed-semantic") {
          if (payload.evidenceAttached && hasRepositoryEvidenceDiagnostic(validation)) {
            // Bounded evidence fallback: evidence remains in Project's own details; never invent a revision.
            const fallback = buildIr(payload.project, undefined, false);
            payload.ir = fallback.ir;
            payload.mapping = fallback.mapping;
            payload.evidenceAttached = false;
            ir = fallback.ir;
            continue;
          }
          throw new ArchifyLayoutError("Archify rejected the diagram semantics.", diagnosticLines(validation));
        }
        if (verdict === "failed-layout") {
          diagnostics.splice(0, diagnostics.length, ...diagnosticLines(validation));
          ir = repairIr(ir, diagnostics, attempt + 1);
          continue;
        }
        const delivered = await this.invokeDeliver(ir, controller.signal);
        if (delivered.result.ok && delivered.html) {
          const receipt = this.receiptFrom(delivered.result, payload.mapping, attempt);
          payload.ir = ir;
          cacheReceipt(this.lastReceipts, `${document.diagramId}:${JSON.stringify(ir)}`, structuredClone(receipt));
          return diagramArtifact(document, "html", delivered.html);
        }
        const lines = diagnosticLines(delivered.result);
        diagnostics.splice(0, diagnostics.length, ...lines);
        const deliverVerdict = validationVerdict(delivered.result);
        if (deliverVerdict === "failed-semantic") throw new ArchifyLayoutError("Archify rejected the diagram semantics.", lines);
        ir = repairIr(ir, lines, attempt + 1);
      }
      throw new ArchifyLayoutError("Archify could not lay out this diagram within the bounded repair budget.", diagnostics);
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (this.active.get(operationId) === controller) this.active.delete(operationId);
    }
  }

  export(document: DiagramAdapterDocument, options: DiagramAdapterExportOptions = {}): Promise<DiagramAdapterArtifact> {
    return this.render(document, options);
  }

  cancel(operationId: string): void {
    this.active.get(operationId)?.abort();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.active.values()) controller.abort();
    this.active.clear();
    this.lastReceipts.clear();
  }
}
