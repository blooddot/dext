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
} from "../../contracts/projectDiagram.js";
import type {
DiagramAdapterArtifact,
DiagramAdapterCapability,
DiagramAdapterDocument,
DiagramAdapterExportOptions,
DiagramAdapterRenderOptions,
ProjectDiagramAdapter
} from "../../contracts/projectDiagramAdapter.js";
import { assertDiagramDocument, diagramArtifact, diagramReceipt, readDiagramOutput, runDiagramProcess, withDiagramFiles } from "./projectDiagramProcess.js";

const KINDS = ["architecture", "workflow", "sequence", "data_flow", "lifecycle", "tree", "class"] as const;
const RUNTIME_VERSION = "3.2.0+e62275b";
const PACKAGE_VERSION = "3.2.0";
const LOCALE = "zh-CN";
const MAX_LAYOUT_REPAIRS = 2;
const ASSET_CHECKS: readonly { path: string; label: string }[] = [
  { path: "bin/archify.mjs", label: "CLI" },
  { path: "bin/delivery-update.mjs", label: "delivery update helper" },
  { path: "assets/template.html", label: "HTML template" },
  { path: "scripts/check-render-output.mjs", label: "render output checker" },
  { path: "explainer/check.mjs", label: "explainer checker" },
  { path: "locales/manifest.json", label: "locale manifest" },
  { path: "locales/zh-CN.json", label: "zh-CN locale" },
  { path: "renderers/shared/owned-temp-directory.mjs", label: "owned temp directory helper" },
  { path: "renderers/architecture/render-architecture.mjs", label: "architecture renderer" },
  { path: "renderers/workflow/render-workflow.mjs", label: "workflow renderer" },
  { path: "renderers/sequence/render-sequence.mjs", label: "sequence renderer" },
  { path: "renderers/dataflow/render-dataflow.mjs", label: "dataflow renderer" },
  { path: "renderers/lifecycle/render-lifecycle.mjs", label: "lifecycle renderer" },
  { path: "renderers/tree/render-tree.mjs", label: "tree renderer" },
  { path: "renderers/class/render-class.mjs", label: "class renderer" },
  { path: "renderers/erd/grid.mjs", label: "class grid layout helper" },
  { path: "schemas/common.schema.json", label: "common schema" },
  { path: "schemas/architecture.schema.json", label: "architecture schema" },
  { path: "schemas/workflow.schema.json", label: "workflow schema" },
  { path: "schemas/sequence.schema.json", label: "sequence schema" },
  { path: "schemas/dataflow.schema.json", label: "dataflow schema" },
  { path: "schemas/lifecycle.schema.json", label: "lifecycle schema" },
  { path: "schemas/tree.schema.json", label: "tree schema" },
  { path: "schemas/class.schema.json", label: "class schema" },
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
  /** Deliver receipts report the artifact checks under `validation` instead of `composition`. */
  validation?: {
    compositionStatus?: string;
    errors?: number;
    warnings?: number;
    compositionIssues?: unknown[];
  };
}

export class ArchifyLayoutError extends Error {
  constructor(message: string, readonly diagnostics: readonly string[]) { super(message); this.name = "ArchifyLayoutError"; }
}

const KIND_LABELS: Record<string, string> = {
  calls: "calls", returns: "returns", depends_on: "depends on", contains: "contains", reads: "reads", writes: "writes",
  publishes: "publishes", subscribes: "subscribes", transitions: "transitions", flows_to: "flows to", unknown: "related"
};

/**
 * Every renderer draws a node's label and sublabel as one unwrapped line and
 * rejects the diagram outright when the text still needs more width than the box
 * has at its legible minimum — `renderers/shared/text-fit.mjs` uses a 6px
 * minimum font, 0.6px of advance per text unit and 8px of horizontal padding.
 * Dext therefore authors each box from the text it has to hold and truncates
 * whatever is wider, because shrink-to-fit is a rescue for ordinary overruns and
 * a rejected diagram renders nothing at all.
 */
const MIN_TEXT_FONT = 6;
const TEXT_WIDTH_FACTOR = 0.6;
const TEXT_PADDING = 8;

/** Truncate to what a box can still render, keeping the ellipsis inside the budget. */
function fitText(value: string, maxUnits: number): string {
  if (textUnits(value) <= maxUnits) return value;
  const characters = [...value];
  while (characters.length && textUnits(`${characters.join("")}…`) > maxUnits) characters.pop();
  return characters.length ? `${characters.join("")}…` : value.slice(0, 1);
}

/** Longest single-line label a box of `width` may keep, per renderer metric. */
function fitLabelUnits(width: number, perUnit: number, slack: number): number {
  return Math.max(1, Math.floor((width + slack) / perUnit));
}

/** Longest sublabel a box of `width` can render at its legible minimum. */
function fitSublabelUnits(width: number): number {
  return Math.max(1, Math.floor((width - TEXT_PADDING) / (MIN_TEXT_FONT * TEXT_WIDTH_FACTOR)));
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
    output: "diagram.html",
    quality_profile: "standard",
    locale: LOCALE,
    ...(repositoryMeta ? { repository: repositoryMeta } : {}),
    ...extra
  };
}

/**
 * Architecture boxes are authored to the text they hold — every renderer rejects
 * a label that does not fit at its legible minimum — and placed on a layered grid
 * of explicit coordinates.
 *
 * The IR's own grid mode cannot be used unmodified: it steps by `cellW`/`cellH`
 * regardless of a component's declared `size`, so boxes wider than the cell
 * overlap. Overlapping boxes are what leave the automatic router with no clear
 * dogleg, and its documented fallback then returns a route that violates the side
 * the validator infers from the relative positions. The grid is therefore sized
 * from the widest box, and the nodes are ordered by graph rank first so that
 * related components land in neighbouring cells instead of in the model's own
 * listing order.
 */
const ARCHITECTURE = {
  labelUnit: 6.6,
  minWidth: 200,
  maxWidth: 380,
  height: 72,
  gapX: 90,
  gapY: 110,
  /** The upstream grid's own origin (`renderers/architecture/grid.mjs`). */
  origin: [40, 80],
  widthFor(label: string): number {
    return Math.max(ARCHITECTURE.minWidth, Math.min(ARCHITECTURE.maxWidth, Math.round(textUnits(label) * ARCHITECTURE.labelUnit) + 40));
  }
} as const;

interface ArchitectureCell {
  col: number;
  row: number;
  width: number;
}

/**
 * The right edge of a cell, the channel to the right of its column, and the channel
 * below its row. Components never occupy a gutter, so an authored route that stays in
 * them cannot be rejected for crossing an unrelated component — which is exactly what
 * the automatic router runs into: its two dogleg candidates travel along the
 * endpoints' own centre lines, and in a grid those lines pass straight through the
 * cells between them.
 */
function architectureGeometry(cell: ArchitectureCell): { exitX: number; cy: number; columnGutter: number; rowChannel: number } {
  const pitchX = cell.width + ARCHITECTURE.gapX;
  const pitchY = ARCHITECTURE.height + ARCHITECTURE.gapY;
  const x = ARCHITECTURE.origin[0] + cell.col * pitchX;
  const y = ARCHITECTURE.origin[1] + cell.row * pitchY;
  return {
    exitX: x + cell.width,
    cy: y + ARCHITECTURE.height / 2,
    columnGutter: x + cell.width + ARCHITECTURE.gapX / 2,
    rowChannel: y + ARCHITECTURE.height + ARCHITECTURE.gapY / 2
  };
}

/**
 * Route one connection out of the source's right side, along the gutters, and into
 * the target's right side. The authored `fromSide`/`toSide` and the endpoint segments
 * agree by construction, and every middle segment stays in a channel no component
 * occupies.
 */
function architectureVia(from: ArchitectureCell, to: ArchitectureCell): { fromSide: string; toSide: string; via: number[][]; labelSegment: number; labelAt?: number[] } {
  const a = architectureGeometry(from);
  const b = architectureGeometry(to);
  if (from.col === to.col) {
    if (from.row === to.row) {
      // A self-reference needs a real loop with distinct endpoint sides, not an out-and-back spur.
      return { fromSide: "right", toSide: "bottom", labelSegment: 2,
        via: [[a.columnGutter, a.cy], [a.columnGutter, a.rowChannel], [a.exitX - from.width / 2, a.rowChannel]] };
    }
    // Stop at the target row. The general U-shaped route would descend below both
    // endpoints, repeat the same corner, then retrace the gutter back to the target.
    return { fromSide: "right", toSide: "right", labelSegment: 1,
      via: [[a.columnGutter, a.cy], [a.columnGutter, b.cy]],
      // Keep long-route labels in the gap before the destination, away from intermediate boxes.
      labelAt: [a.columnGutter, b.cy + Math.sign(a.cy - b.cy) * (ARCHITECTURE.height + ARCHITECTURE.gapY) / 2] };
  }
  const channel = Math.max(a.rowChannel, b.rowChannel);
  return {
    fromSide: "right",
    toSide: "right",
    labelSegment: 2,
    via: [
      [a.columnGutter, a.cy],
      [a.columnGutter, channel],
      [b.columnGutter, channel],
      [b.columnGutter, b.cy]
    ]
  };
}

interface ArchitectureComponentGeometry { id: string; row: number; col: number; size: number[] }
interface ArchitectureConnectionGeometry { via: number[][]; label?: string; labelAt?: number[]; labelSegment?: number }

/** Upstream's automatic canvas bounds omit authored via points. Include the geometry we own. */
function architectureViewBox(components: readonly ArchitectureComponentGeometry[], connections: readonly ArchitectureConnectionGeometry[],
  boundaries: readonly { wraps: string[]; label: string }[], cellWidth: number, gapX: number, gapY: number): number[] {
  const boxes = new Map(components.map(component => [component.id, {
    x: ARCHITECTURE.origin[0] + component.col * (cellWidth + gapX),
    y: ARCHITECTURE.origin[1] + component.row * (ARCHITECTURE.height + gapY),
    width: component.size[0] ?? cellWidth, height: component.size[1] ?? ARCHITECTURE.height
  }]));
  let right = 0, bottom = 0;
  for (const box of boxes.values()) { right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height); }
  for (const boundary of boundaries) {
    const members = boundary.wraps.flatMap(id => boxes.has(id) ? [boxes.get(id)!] : []);
    if (!members.length) continue;
    // Match the renderer's frame padding and conservatively allow its preferred title size.
    right = Math.max(right, ...members.map(box => box.x + box.width + 30),
      Math.min(...members.map(box => box.x)) - 30 + 4 + Math.max(30, textUnits(boundary.label) * 5.4 + 10));
    bottom = Math.max(bottom, ...members.map(box => box.y + box.height + 20));
  }
  for (const connection of connections) {
    for (const point of connection.via) { right = Math.max(right, point[0]!); bottom = Math.max(bottom, point[1]!); }
    const segment = connection.labelSegment ?? 1;
    const a = connection.via[segment - 1], b = connection.via[segment];
    const label = connection.labelAt ?? (a && b ? [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2 - 10] : undefined);
    if (connection.label && label) {
      right = Math.max(right, label[0]! + Math.max(30, textUnits(connection.label) * 4.8 + 10) / 2);
      bottom = Math.max(bottom, label[1]! + 4);
    }
  }
  // Space for stroke/arrow ends, plus the legend below the complete routed graph.
  return [Math.max(320, Math.ceil(right + 40)), Math.max(240, Math.ceil(bottom + 100))];
}

function buildArchitecture(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const ranks = rankNodes(project.nodes, flowEdges(project));
  const ranked = [...project.nodes].sort((left, right) =>
    (ranks.get(left.id) ?? 0) - (ranks.get(right.id) ?? 0)
    || project.nodes.indexOf(left) - project.nodes.indexOf(right));
  const count = Math.max(1, ranked.length);
  const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(count))));
  // Every component takes the cell's width. The router infers an endpoint side from
  // the boxes' relative centres (`defaultFromSide`), so two components stacked in one
  // column with different widths are inferred as left/right of each other and neither
  // of the router's two doglegs can satisfy that side; with equal widths their centres
  // coincide and the inference is the vertical one their actual relationship matches.
  const cellWidth = Math.max(ARCHITECTURE.minWidth, Math.min(ARCHITECTURE.maxWidth,
    ...ranked.map((node) => ARCHITECTURE.widthFor(node.label))));
  const cellByNodeId = new Map<string, ArchitectureCell>();
  const components = ranked.map((node, index) => {
    const id = mapNode(mapping, node, usedNodes);
    const sources = evidenceSources(node, repository, attached);
    const row = Math.floor(index / columns);
    const col = index % columns;
    cellByNodeId.set(node.id, { col, row, width: cellWidth });
    return {
      id,
      type: componentType(node),
      label: fitText(node.label, fitLabelUnits(cellWidth, ARCHITECTURE.labelUnit, 8)),
      ...(node.description ? { sublabel: fitText(node.description, fitSublabelUnits(cellWidth)) } : {}),
      row,
      col,
      size: [cellWidth, ARCHITECTURE.height],
      ...(sources ? { sources } : {})
    };
  });
  const boundaries = (project.semantics?.boundaries ?? []).flatMap((boundary) => {
    const wraps = boundary.nodeIds.map((id) => mapping.ids[id]).filter((id): id is string => Boolean(id));
    return wraps.length ? [{ kind: boundary.kind ?? "region", label: boundary.label, wraps }] : [];
  });
  const connections = project.relations.flatMap((relation) => {
    const from = mapping.ids[relation.from];
    const to = mapping.ids[relation.to];
    const fromCell = cellByNodeId.get(relation.from);
    const toCell = cellByNodeId.get(relation.to);
    if (!from || !to || !fromCell || !toCell) return [];
    const id = mapRelation(mapping, relation, usedRelations);
    return [{
      id,
      from,
      to,
      label: relationLabel(relation),
      ...architectureVia(fromCell, toCell),
      ...(relation.exception ? { variant: "dashed" } : {})
    }];
  });
  return {
    mapping,
    ir: {
      schema_version: 1,
      diagram_type: "architecture",
      meta: baseMeta(project, repository, attached, { viewBox: architectureViewBox(components, connections, boundaries, cellWidth, ARCHITECTURE.gapX, ARCHITECTURE.gapY) }),
      layout: { mode: "grid", cols: columns, gapX: ARCHITECTURE.gapX, gapY: ARCHITECTURE.gapY,
        cellW: Math.max(...components.map((component) => component.size[0] ?? 0)),
        cellH: Math.max(...components.map((component) => component.size[1] ?? 0)) },
      components,
      ...(boundaries.length ? { boundaries } : {}),
      connections
    }
  };
}

const TREE = {
  direction: "right",
  nodeW: 220,
  nodeMaxW: 360,
  gapX: 48,
  gapY: 24
} as const;

function treeDepth(node: ProjectDiagramNode, byId: ReadonlyMap<string, ProjectDiagramNode>, trail = new Set<string>()): number {
  if (!node.parentId) return 0;
  if (trail.has(node.id)) throw new Error(`Tree diagram contains a parent cycle at '${node.id}'.`);
  const parent = byId.get(node.parentId);
  if (!parent) throw new Error(`Tree node '${node.id}' references missing parent '${node.parentId}'.`);
  return treeDepth(parent, byId, new Set([...trail, node.id])) + 1;
}

function buildTree(project: ProjectDiagram): BuiltIr {
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const byId = new Map(project.nodes.map((node) => [node.id, node]));
  const roots = project.nodes.filter((node) => !node.parentId);
  if (roots.length !== 1) throw new Error(`Tree diagram needs exactly one root node; found ${roots.length}.`);
  const depths = new Map(project.nodes.map((node) => [node.id, treeDepth(node, byId)]));
  const ordered = project.nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => (depths.get(left.node.id) ?? 0) - (depths.get(right.node.id) ?? 0) || left.index - right.index);
  for (const { node } of ordered) mapNode(mapping, node, usedNodes);
  const nodes = ordered.map(({ node }) => ({
    id: mapping.ids[node.id]!,
    label: fitText(node.label, fitLabelUnits(TREE.nodeMaxW, 6.4, 8)),
    ...(node.parentId ? { parent: mapping.ids[node.parentId]! } : {}),
    ...(node.description ? { sublabel: fitText(node.description, fitSublabelUnits(TREE.nodeMaxW)) } : {})
  }));
  return {
    mapping,
    ir: {
      schema_version: 1,
      diagram_type: "tree",
      meta: baseMeta(project, undefined, false),
      layout: { ...TREE },
      nodes
    }
  };
}

const CLASS = {
  columns: 5,
  maxTypes: 60,
  maxMembers: 12,
  gapX: 128,
  gapY: 84,
  typeW: 240,
  typeMaxW: 360
} as const;

function buildClass(project: ProjectDiagram): BuiltIr {
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const selected = project.nodes.slice(0, CLASS.maxTypes);
  for (const node of selected) mapNode(mapping, node, usedNodes);
  const types = selected.map((node, index) => {
    const members = (node.members ?? []).slice(0, CLASS.maxMembers);
    const attributes = members.filter((member) => member.kind === "attribute").map((member) => ({
      name: member.name,
      ...(member.type ? { type: member.type } : {}),
      ...(member.visibility ? { visibility: member.visibility } : {}),
      ...(member.static ? { static: true } : {})
    }));
    const methods = members.filter((member) => member.kind === "method").map((member) => ({
      name: member.name,
      ...(member.parameters ? { parameters: member.parameters } : {}),
      ...(member.returns ? { returns: member.returns } : {}),
      ...(member.visibility ? { visibility: member.visibility } : {}),
      ...(member.static ? { static: true } : {}),
      ...(member.abstract ? { abstract: true } : {})
    }));
    return {
      id: mapping.ids[node.id]!,
      label: fitText(node.label, fitLabelUnits(CLASS.typeMaxW, 7, 8)),
      kind: node.classKind ?? "class",
      ...(node.description ? { sublabel: fitText(node.description, fitSublabelUnits(CLASS.typeMaxW)) } : {}),
      row: Math.floor(index / CLASS.columns),
      col: index % CLASS.columns,
      ...(attributes.length ? { attributes } : {}),
      ...(methods.length ? { methods } : {})
    };
  });
  const relationships = project.relations
    .filter((relation) => relation.kind === "inheritance" || relation.kind === "realization")
    .flatMap((relation) => {
      const from = mapping.ids[relation.from];
      const to = mapping.ids[relation.to];
      if (!from || !to) return [];
      return [{
        id: mapRelation(mapping, relation, usedRelations),
        from,
        to,
        kind: relation.kind,
        ...(relation.label ? { label: truncate(relation.label, 120) } : {})
      }];
    });
  return {
    mapping,
    ir: {
      schema_version: 1,
      diagram_type: "class",
      meta: baseMeta(project, undefined, false),
      layout: { mode: "grid", gapX: CLASS.gapX, gapY: CLASS.gapY, typeW: CLASS.typeW, typeMaxW: CLASS.typeMaxW },
      types,
      ...(relationships.length ? { relationships } : {})
    }
  };
}

/** Workflow node label width metric and column budget, from the compiler's own lints. */
const WORKFLOW = {  labelUnit: 6.8,
  /** Columns a lane holds before the rail continues in a continuation lane. */
  columns: 6
} as const;

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
  // Columns are consumed per lane in rank order. Two nodes that share a rank must
  // not share a cell: `col = rank % 6` put them on the same column centre, and the
  // compiler reports the collision as "less than 8px apart in lane …" and refuses
  // the diagram. Ordering by rank first keeps the left-to-right reading order.
  const railPosition = new Map<ProjectDiagramNode, number>();
  const laneCursor = new Map<string, number>();
  [...project.nodes]
    .sort((left, right) => (ranks.get(left.id) ?? 0) - (ranks.get(right.id) ?? 0)
      || project.nodes.indexOf(left) - project.nodes.indexOf(right))
    .forEach((node) => {
      const declared = node.laneId && laneById.has(node.laneId) ? node.laneId : declaredLanes[0]!.id;
      const baseLane = archifyLaneByProjectLane.get(declared)!;
      const next = laneCursor.get(baseLane) ?? 0;
      laneCursor.set(baseLane, next + 1);
      railPosition.set(node, next);
    });
  const pickLane = (node: ProjectDiagramNode): { lane: string; col: number } => {
    const declared = node.laneId && laneById.has(node.laneId) ? node.laneId : declaredLanes[0]!.id;
    const baseLane = archifyLaneByProjectLane.get(declared)!;
    const next = railPosition.get(node) ?? 0;
    const band = Math.floor(next / WORKFLOW.columns);
    if (band === 0) return { lane: baseLane, col: next % WORKFLOW.columns };
    const continuationId = `${baseLane}-cont-${band}`;
    if (!usedLanes.has(continuationId)) {
      usedLanes.add(continuationId);
      const source = laneById.get(declared)!;
      lanes.push({ id: continuationId, label: `${source.label} (cont. ${band + 1})`, variant: source.variant === "exception" ? "exception" : "normal" });
    }
    return { lane: continuationId, col: next % WORKFLOW.columns };
  };
  const nodes = project.nodes.map((node) => {
    const id = mapNode(mapping, node, usedNodes);
    const placement = pickLane(node);
    const sources = evidenceSources(node, repository, attached);
    const width = Math.max(92, Math.min(360, Math.round(textUnits(node.label) * WORKFLOW.labelUnit) + 24));
    return {
      id,
      lane: placement.lane,
      col: placement.col,
      type: componentType(node),
      label: fitText(node.label, fitLabelUnits(width, WORKFLOW.labelUnit, 6)),
      width,
      ...(node.description ? { sublabel: fitText(node.description, fitSublabelUnits(width)) } : {}),
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

/**
 * The sequence renderer grants each participant a box derived from the canvas:
 * `participantW = clamp((viewBox[0] - 124) / n - 24, 86, 190)` under
 * `column_fit: "spread"`, and message rows must stay inside
 * `[160, viewBox[1] - 83]`. Dext has to size the canvas for the diagram it built;
 * the default 920x760 squeezes seven participants into 90px boxes no real label
 * fits, and pushes the later messages past the readable timeline.
 */
const SEQUENCE = {
  sideMargin: 62,
  minBox: 86,
  maxBox: 190,
  baseWidth: 920,
  baseHeight: 760,
  labelUnit: 6.8,
  sublabelUnit: 6,
  firstMessageY: 190,
  messageGap: 70,
  /** lifelineTop (142) + 18 + the legend reserve below the timeline + 18. */
  topMessageLimit: 160,
  bottomReserve: 90
} as const;

/** Participant box width the renderer derives from a canvas width. */
function sequenceBoxWidth(viewWidth: number, participantCount: number): number {
  return Math.max(SEQUENCE.minBox, Math.min(SEQUENCE.maxBox, Math.round((viewWidth - SEQUENCE.sideMargin * 2) / participantCount) - 24));
}

function buildSequence(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  const semantics = project.semantics ?? {};
  const participantNodes = [...(semantics.participants ?? [])].sort((left, right) => left.order - right.order);
  if (participantNodes.length < 2) throw new Error("Sequence diagram needs at least two evidenced participants.");
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const nodeById = new Map(project.nodes.map((node) => [node.id, node]));
  const ordered = participantNodes.flatMap((participant) => {
    const node = nodeById.get(participant.nodeId);
    return node ? [node] : [];
  });
  if (ordered.length < 2) throw new Error("Sequence diagram participants do not reference existing nodes.");
  // Size the canvas so the widest label gets a box it fits in, then truncate
  // whatever is still too wide for the box the canvas actually grants.
  const widestLabel = Math.max(...ordered.map((node) => textUnits(node.label) * SEQUENCE.labelUnit));
  const desiredBox = Math.min(SEQUENCE.maxBox, Math.max(SEQUENCE.minBox, Math.round(widestLabel) - 6));
  const viewWidth = Math.max(SEQUENCE.baseWidth, Math.round((desiredBox + 24) * ordered.length + SEQUENCE.sideMargin * 2));
  const boxWidth = sequenceBoxWidth(viewWidth, ordered.length);
  const participants = ordered.map((node) => {
    const id = mapNode(mapping, node, usedNodes);
    const sources = evidenceSources(node, repository, attached);
    return {
      id,
      type: componentType(node),
      label: fitText(node.label, fitLabelUnits(boxWidth, SEQUENCE.labelUnit, 6)),
      ...(node.description ? { sublabel: fitText(node.description, fitSublabelUnits(boxWidth)) } : {}),
      ...(sources ? { sources } : {})
    };
  });
  const messageOrder = new Map((semantics.messages ?? []).map((message) => [message.relationId, message.order]));
  const sorted = sortedRelations(project, Object.fromEntries(messageOrder));
  const messageKinds = new Map((semantics.messages ?? []).map((message) => [message.relationId, message.kind]));
  const messages = sorted
    .filter((relation) => mapping.ids[relation.from] && mapping.ids[relation.to])
    .map((relation, index) => {
      const id = mapRelation(mapping, relation, usedRelations);
      const kind = messageKinds.get(relation.id);
      return {
        id,
        from: mapping.ids[relation.from],
        to: mapping.ids[relation.to],
        y: SEQUENCE.firstMessageY + index * SEQUENCE.messageGap,
        label: truncate(relationLabel(relation), 120),
        ...(kind === "return" || relation.kind === "returns" ? { variant: "return" } : {}),
        ...(relation.condition ? { note: truncate(relation.condition, 200) } : {})
      };
    });
  const viewHeight = Math.max(SEQUENCE.baseHeight,
    SEQUENCE.firstMessageY + Math.max(0, messages.length - 1) * SEQUENCE.messageGap + SEQUENCE.bottomReserve);
  return {
    mapping,
    ir: {
      schema_version: 1,
      diagram_type: "sequence",
      meta: baseMeta(project, repository, attached, { viewBox: [viewWidth, viewHeight], column_fit: "spread" }),
      participants,
      messages
    }
  };
}

/**
 * The data-flow renderer fixes its stage columns: `stageX(i) = 100 + i * 215`
 * with a node centred on each column and at most five rows
 * (`renderers/dataflow/render-dataflow.mjs`). Dext therefore caps a node to what
 * the pitch can hold instead of letting a wide box spill into the neighbouring
 * stage, where the flows that cross it are rejected as `clean-flow` violations.
 */
const DATAFLOW = {
  labelUnit: 6.2,
  columnPitch: 215,
  leftX: 100,
  stageWidth: 168,
  stageY: 46,
  stageHeight: 36,
  stageBottomPad: 74,
  nodeHeight: 58,
  rowYs: [128, 242, 356, 470, 584],
  minWidth: 120,
  /** `leftX - width / 2 >= 24` for the first stage, and half the pitch on each side. */
  maxWidth: 150,
  widthFor(label: string): number {
    return Math.max(DATAFLOW.minWidth, Math.min(DATAFLOW.maxWidth, Math.round(textUnits(label) * DATAFLOW.labelUnit) + 40));
  }
} as const;

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
    if (row >= DATAFLOW.rowYs.length) {
      throw new Error(`Data-flow stage '${stages[stage]!.id}' holds more than ${DATAFLOW.rowYs.length} nodes; the renderer's row grid is fixed.`);
    }
    rowByStage.set(stage, row + 1);
    const sources = evidenceSources(node, repository, attached);
    const width = DATAFLOW.widthFor(node.label);
    return {
      id,
      type: componentType(node),
      label: fitText(node.label, fitLabelUnits(width, DATAFLOW.labelUnit, 6)),
      ...(node.description ? { sublabel: fitText(node.description, fitSublabelUnits(width)) } : {}),
      width,
      stage,
      row,
      ...(sources ? { sources } : {})
    };
  });
  const stageOfNode = new Map(nodes.map((node) => [node.id, node.stage]));
  const rowOfNode = new Map(nodes.map((node) => [node.id, node.row]));
  const placement = new Map<string, number>();
  const flows = project.relations.map((relation) => {
    const id = mapRelation(mapping, relation, usedRelations);
    const label = relation.condition ? `${relationLabel(relation)}（${relation.condition}）` : relationLabel(relation);
    const fromStage = stageOfNode.get(mapping.ids[relation.from] ?? "");
    const toStage = stageOfNode.get(mapping.ids[relation.to] ?? "");
    const fromRow = rowOfNode.get(mapping.ids[relation.from] ?? "") ?? 0;
    const toRow = rowOfNode.get(mapping.ids[relation.to] ?? "") ?? 0;
    if (fromStage === undefined || toStage === undefined) {
      return { id, from: mapping.ids[relation.from], to: mapping.ids[relation.to], label, ...(relation.exception ? { variant: "dashed" } : {}) };
    }
    // Labels are authored into the free corridor under the deepest row the flow touches:
    // the renderer's default puts them just above the route's first corner, which in a
    // fixed stage grid is inside the node the flow starts from. Each row's corridor is
    // consumed in order, so no two labels in it can share a line.
    const row = Math.min(Math.max(fromRow, toRow), DATAFLOW.rowYs.length - 1);
    const stack = placement.get(String(row)) ?? 0;
    placement.set(String(row), stack + 1);
    const center = (stage: number): number => DATAFLOW.leftX + stage * DATAFLOW.columnPitch;
    return {
      id,
      from: mapping.ids[relation.from],
      to: mapping.ids[relation.to],
      label,
      labelAt: [
        Math.round((center(fromStage) + center(toStage)) / 2),
        DATAFLOW.rowYs[row]! + DATAFLOW.nodeHeight + 12 + stack * 18
      ],
      ...(relation.exception ? { variant: "dashed" } : {})
    };
  });
  const lastStageX = DATAFLOW.leftX + (stages.length - 1) * DATAFLOW.columnPitch;
  const viewBoxWidth = Math.max(760, Math.ceil(lastStageX + DATAFLOW.stageWidth / 2 + 64));
  const maxRows = Math.max(1, ...[...rowByStage.values()]);
  const lastRowY = DATAFLOW.rowYs[Math.min(maxRows - 1, DATAFLOW.rowYs.length - 1)]!;
  const viewBoxHeight = Math.max(560, Math.ceil(lastRowY + DATAFLOW.nodeHeight + DATAFLOW.stageBottomPad + 24));
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

/** CJK-aware unit count, shared with the renderer's own width estimates. */
function textUnits(value: string): number {
  let units = 0;
  for (const character of value) units += character.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return units;
}

function stateType(node: ProjectDiagramNode, kind: "initial" | "terminal" | "normal", outcome?: "success" | "failure"): string {
  if (kind === "initial") return "start";
  // A terminal without an explicit success outcome is a non-completion exit (Stopped, Blocked,
  // Incomplete); rendering it as `success` would contradict the documented lifecycle.
  if (kind === "terminal") return outcome === "success" ? "success" : "failure";
  if (node.role === "store") return "waiting";
  if (node.role === "actor") return "external";
  if (node.role === "event") return "neutral";
  return "active";
}

/**
 * The v3 renderer derives all geometry from `mainPath` and the semantic states.
 * Dext therefore only chooses the story: a shortest transition path from the
 * initial state to a success terminal, falling back to any terminal and then to
 * the furthest reachable state. Every consecutive pair is an actual transition,
 * which is the one structural rule the renderer enforces for the main path.
 */
function lifecycleMainPath(
  project: ProjectDiagram,
  stateByNode: ReadonlyMap<string, { kind: "initial" | "terminal" | "normal"; outcome?: "success" | "failure" }>,
  transitions: readonly ProjectDiagramRelation[]
): string[] {
  const start = project.nodes.find((node) => stateByNode.get(node.id)?.kind === "initial") ?? project.nodes[0];
  if (!start) return [];
  const adjacency = new Map<string, string[]>();
  for (const node of project.nodes) adjacency.set(node.id, []);
  for (const relation of transitions) {
    const next = adjacency.get(relation.from);
    if (next && !next.includes(relation.to)) next.push(relation.to);
  }
  const terminals = project.nodes.filter((node) => stateByNode.get(node.id)?.kind === "terminal");
  const successTerminals = new Set(terminals
    .filter((node) => stateByNode.get(node.id)?.outcome === "success")
    .map((node) => node.id));
  const allTerminals = new Set(terminals.map((node) => node.id));

  const search = (goals?: ReadonlySet<string>): { path: string[]; furthest: string[] } => {
    const parent = new Map<string, string | undefined>([[start.id, undefined]]);
    const depth = new Map<string, number>([[start.id, 0]]);
    const queue = [start.id];
    let deepest = start.id;
    let deepestDepth = 0;
    const build = (id: string): string[] => {
      const path = [id];
      let cursor = parent.get(id);
      while (cursor) { path.unshift(cursor); cursor = parent.get(cursor); }
      return path;
    };
    while (queue.length) {
      const id = queue.shift()!;
      if (goals?.has(id)) return { path: build(id), furthest: build(id) };
      for (const target of adjacency.get(id) ?? []) {
        if (parent.has(target)) continue;
        parent.set(target, id);
        const nextDepth = (depth.get(id) ?? 0) + 1;
        depth.set(target, nextDepth);
        if (nextDepth > deepestDepth) { deepest = target; deepestDepth = nextDepth; }
        queue.push(target);
      }
    }
    // No requested goal is reachable: keep a real connected chain instead of a
    // fabricated state order, so the renderer's main-path gap check still holds.
    return { path: [], furthest: build(deepest) };
  };

  const preferred = successTerminals.size ? search(successTerminals).path : [];
  if (preferred.length >= 2) return preferred;
  const terminal = allTerminals.size ? search(allTerminals).path : [];
  if (terminal.length >= 2) return terminal;
  return search().furthest;
}

function buildLifecycle(project: ProjectDiagram, repository: ArchifyRepository | undefined, attached: boolean): BuiltIr {
  const semantics = project.semantics ?? {};
  const stateDefinitions = semantics.states ?? [];
  if (!stateDefinitions.length) throw new Error("Lifecycle diagram is missing explicit initial/terminal states.");
  const mapping = emptyMapping();
  const usedNodes = new Set<string>();
  const usedRelations = new Set<string>();
  const stateByNode = new Map(stateDefinitions.map((state) => [state.nodeId, state]));
  const transitionIds = new Set((semantics.transitions ?? []).map((transition) => transition.relationId));
  const transitionRelations = project.relations.filter((relation) => transitionIds.has(relation.id) || relation.kind === "transitions");
  const transitionByRelation = new Map((semantics.transitions ?? []).map((transition) => [transition.relationId, transition]));
  const mainPathIds = lifecycleMainPath(project, stateByNode, transitionRelations);
  if (mainPathIds.length < 2) {
    throw new Error("Lifecycle diagram needs a connected main path of at least two states.");
  }
  const states = project.nodes.map((node) => {
    const id = mapNode(mapping, node, usedNodes);
    const definition = stateByNode.get(node.id);
    return {
      id,
      type: stateType(node, definition?.kind ?? "normal", definition?.outcome),
      label: node.label
    };
  });
  const transitions = transitionRelations.map((relation) => {
    const definition = transitionByRelation.get(relation.id);
    const label = definition?.event ?? relation.label;
    const note = definition?.condition ?? relation.condition;
    return {
      id: mapRelation(mapping, relation, usedRelations),
      from: mapping.ids[relation.from]!,
      to: mapping.ids[relation.to]!,
      ...(label ? { label: truncate(label, 60) } : {}),
      ...(note ? { note: truncate(note, 200) } : {}),
      ...(relation.exception ? { variant: "dashed" } : {})
    };
  });
  return {
    mapping,
    ir: {
      schema_version: 3,
      diagram_type: "lifecycle",
      meta: baseMeta(project, repository, attached),
      mainPath: mainPathIds.map((id) => mapping.ids[id]!),
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
    case "tree": return buildTree(project);
    case "class": return buildClass(project);
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

interface UpstreamComposition {
  status?: string;
  errors: number;
  warnings: number;
  issues: readonly unknown[];
}

/** Validate reports `composition`; deliver reports its artifact checks under `validation`. */
function upstreamComposition(result: UpstreamResult): UpstreamComposition {
  const composition = result.composition;
  const validation = result.validation;
  const status = composition?.status ?? validation?.compositionStatus;
  return {
    ...(status !== undefined ? { status } : {}),
    errors: composition?.summary?.errors ?? validation?.errors ?? 0,
    warnings: composition?.summary?.warnings ?? validation?.warnings ?? 0,
    issues: composition?.issues ?? validation?.compositionIssues ?? []
  };
}

function compositionIssues(result: UpstreamResult): DiagramValidationIssue[] {
  const issues: DiagramValidationIssue[] = [];
  const composition = upstreamComposition(result);
  for (const entry of composition.issues.slice(0, 40)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const message = typeof record["message"] === "string" ? record["message"] : JSON.stringify(record);
    issues.push({
      code: typeof record["code"] === "string" ? record["code"] : "archify_composition",
      message: truncate(message, 2000),
      severity: record["severity"] === "warning" ? "warning" : "info"
    });
  }
  if (!issues.length && composition.warnings > 0) {
    issues.push({ code: "archify_composition", message: `${composition.warnings} upstream composition warning(s).`, severity: "warning" });
  }
  return issues;
}

function validationVerdict(result: UpstreamResult): "passed" | "warning" | "failed-semantic" | "failed-layout" {
  if (result.ok) return upstreamComposition(result).warnings > 0 ? "warning" : "passed";
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
    const previous = (ir["layout"] as Record<string, unknown> | undefined) ?? {};
    const cols = Math.max(1, Math.min(6, Math.round(Number(previous["cols"] ?? Math.ceil(Math.sqrt(components.length)))) || 1));
    const sizeOf = (component: Record<string, unknown>, axis: number): number =>
      Array.isArray(component["size"]) ? Number((component["size"] as unknown[])[axis]) || 0 : 0;
    // The grid steps by cellW/cellH and never by a component's own size
    // (`renderers/architecture/grid.mjs`), so a repair only widens the cell and the
    // gaps. Collapsing the column count is what turned a 22-node diagram into an
    // 11-row canvas whose edges crossed every component between their endpoints.
    const layout = {
      mode: "grid",
      cols,
      gapX: ARCHITECTURE.gapX * (1 + attempt),
      gapY: ARCHITECTURE.gapY * (1 + attempt),
      cellW: Math.max(Number(previous["cellW"]) || 0, ...components.map((component) => sizeOf(component, 0))),
      cellH: Math.max(Number(previous["cellH"]) || 0, ...components.map((component) => sizeOf(component, 1)))
    };
    ir["layout"] = layout;
    const repairedComponents = components.map((component, index) => ({
      ...component,
      ...(text.includes("wider than") || text.includes("sublabel")
        ? { label: typeof component["label"] === "string" ? fitText(component["label"], fitLabelUnits(sizeOf(component, 0), ARCHITECTURE.labelUnit, 8)) : component["label"] }
        : {}),
      row: Math.floor(index / cols),
      col: index % cols
    }));
    ir["components"] = repairedComponents;
    ir["meta"] = {
      ...(ir["meta"] as Record<string, unknown> ?? {}),
      viewBox: architectureViewBox(repairedComponents as ArchitectureComponentGeometry[],
        (ir["connections"] ?? []) as ArchitectureConnectionGeometry[],
        (ir["boundaries"] ?? []) as { wraps: string[]; label: string }[], layout.cellW, layout.gapX, layout.gapY)
    };
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
    const meta = { ...(ir["meta"] as Record<string, unknown> ?? {}) };
    const currentView = Array.isArray(meta["viewBox"]) ? meta["viewBox"] as number[] : [SEQUENCE.baseWidth, SEQUENCE.baseHeight];
    const participants = Array.isArray(ir["participants"]) ? ir["participants"] as Record<string, unknown>[] : [];
    // Re-space on the builder's own grid: widening the gap is what pushed the tail
    // of a long sequence outside the readable timeline the renderer validates.
    const messages = (Array.isArray(ir["messages"]) ? ir["messages"] as Record<string, unknown>[] : [])
      .map((message, index) => ({ ...message, y: SEQUENCE.firstMessageY + index * SEQUENCE.messageGap }));
    ir["messages"] = messages;
    const boxWidth = sequenceBoxWidth(currentView[0] ?? SEQUENCE.baseWidth, Math.max(2, participants.length));
    if (text.includes("wider than") || text.includes("sublabel") || text.includes("participant box")) {
      ir["participants"] = participants.map((participant) => ({
        ...participant,
        label: typeof participant["label"] === "string"
          ? fitText(participant["label"], fitLabelUnits(boxWidth, SEQUENCE.labelUnit, 6)) : participant["label"],
        ...(typeof participant["sublabel"] === "string"
          ? { sublabel: fitText(participant["sublabel"], fitSublabelUnits(boxWidth)) } : {})
      }));
    }
    if (text.includes("timeline") || text.includes("viewbox")) {
      meta["viewBox"] = [currentView[0] ?? SEQUENCE.baseWidth,
        Math.max(currentView[1] ?? SEQUENCE.baseHeight,
          SEQUENCE.firstMessageY + Math.max(0, messages.length - 1) * SEQUENCE.messageGap + SEQUENCE.bottomReserve)];
    }
    meta["column_fit"] = "spread";
    ir["meta"] = meta;
  }
  if (type === "dataflow") {
    const meta = { ...(ir["meta"] as Record<string, unknown> ?? {}) };
    const current = Array.isArray(meta["viewBox"]) ? meta["viewBox"] as number[] : [900, 520];
    meta["viewBox"] = [Math.max(760, current[0] ?? 0), Math.max(420, (current[1] ?? 520) + attempt * 120)];
    ir["meta"] = meta;
  }
  if (type === "class") {
    const layout = { ...(ir["layout"] as Record<string, unknown> ?? {}) };
    if (text.includes("gap") || text.includes("corridor") || text.includes("crossing") || text.includes("border")) {
      layout["gapX"] = Number(layout["gapX"] ?? CLASS.gapX) + attempt * 32;
      layout["gapY"] = Number(layout["gapY"] ?? CLASS.gapY) + attempt * 32;
    }
    if (text.includes("title") || text.includes("text capacity") || text.includes("wider")) {
      layout["typeMaxW"] = Math.max(Number(layout["typeMaxW"] ?? CLASS.typeMaxW), CLASS.typeMaxW + attempt * 40);
      layout["typeW"] = Math.max(Number(layout["typeW"] ?? CLASS.typeW), CLASS.typeW + attempt * 20);
    }
    ir["layout"] = layout;
  }
  // Lifecycle v3 owns all of its geometry: Dext authors no lanes, coordinates,
  // routes, or labels there, so there is nothing a layout-only repair may rewrite.
  return ir;
}

function layoutError(diagnostics: readonly string[]): ArchifyLayoutError {
  return new ArchifyLayoutError(
    "Archify could not lay out this diagram within the bounded repair budget.",
    diagnostics
  );
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
    const composition = upstreamComposition(result);
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
        upstream: JSON.stringify({
          ok: result.ok === true,
          checks: { status: composition.status ?? "", errors: composition.errors, warnings: composition.warnings },
          error: result.error ?? ""
        }).slice(0, 12000)
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
      throw layoutError(diagnostics);
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
