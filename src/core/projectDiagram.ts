/** Diagram kinds understood by Project's adapter protocol. */
export type ProjectDiagramKind = "architecture" | "workflow" | "sequence" | "data_flow" | "lifecycle";

/** Semantic roles are intentionally renderer-neutral. Adapters may map them to their own shapes. */
export type ProjectDiagramNodeRole =
  | "system"
  | "container"
  | "component"
  | "context"
  | "module"
  | "service"
  | "actor"
  | "store"
  | "event"
  | "step"
  | "state"
  | "boundary"
  | "unknown";

export interface ProjectDiagramEvidence {
  path: string;
  symbol?: string;
  line?: number;
  note?: string;
  contentHash?: string;
}

export interface ProjectDiagramNode {
  review?: "draft" | "accepted" | "rejected" | "edited";
  freshness?: "current" | "needs_verification" | "stale" | "conflicted";
  confidence?: number;
  /** Stable Project id. Adapter-specific ids must never replace this value. */
  id: string;
  label: string;
  role: ProjectDiagramNodeRole;
  description?: string;
  parentId?: string;
  /** Ids of Project knowledge objects represented by this node. */
  semanticIds: readonly string[];
  evidence: readonly ProjectDiagramEvidence[];
  /** Renderer-neutral hints; adapters must ignore unknown keys. */
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type ProjectDiagramRelationKind = "calls" | "depends_on" | "contains" | "reads" | "writes" | "publishes" | "subscribes" | "transitions" | "flows_to" | "unknown";

export interface ProjectDiagramRelation {
  review?: "draft" | "accepted" | "rejected" | "edited";
  freshness?: "current" | "needs_verification" | "stale" | "conflicted";
  confidence?: number;
  id: string;
  from: string;
  to: string;
  kind: ProjectDiagramRelationKind;
  label?: string;
  /** Optional sequence/order hint for workflow and sequence diagrams. */
  order?: number;
  evidence: readonly ProjectDiagramEvidence[];
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Canonical diagram document owned by Project. No external adapter fields belong here.
 * This is the only document that is persisted as Project's source of truth.
 */
export interface ProjectDiagramLayoutOverlay {
  adapterId: string;
  version: number;
  nodes: Readonly<Record<string, { x: number; y: number; width?: number; height?: number }>>;
  updatedAt: number;
}

export interface ProjectDiagram {
  review?: "draft" | "accepted" | "rejected" | "edited";
  freshness?: "current" | "needs_verification" | "stale" | "conflicted";
  schemaVersion: 1;
  id: string;
  title: string;
  kind: ProjectDiagramKind;
  nodes: readonly ProjectDiagramNode[];
  relations: readonly ProjectDiagramRelation[];
  /** Monotonic semantic version, independent of renderer versions. */
  version: number;
  updatedAt: number;
  confidence?: number;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type DiagramValidationStatus = "passed" | "failed" | "warning";
export type DiagramValidationSeverity = "error" | "warning" | "info";

export interface DiagramValidationIssue {
  code: string;
  message: string;
  severity: DiagramValidationSeverity;
  nodeId?: string;
  relationId?: string;
  evidence?: readonly ProjectDiagramEvidence[];
}

/** Unified receipt returned by Project and every adapter. */
export interface DiagramValidationReceipt {
  adapterId: string;
  adapterVersion: string;
  status: DiagramValidationStatus;
  checkedAt: number;
  issues: readonly DiagramValidationIssue[];
  /** Optional opaque details retained for diagnostics, never used as Project facts. */
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** Validates only invariants that are independent of a renderer. */
export function validateProjectDiagram(diagram: ProjectDiagram): DiagramValidationIssue[] {
  const issues: DiagramValidationIssue[] = [];
  const nodeIds = new Set<string>();
  for (const node of diagram.nodes) {
    if (nodeIds.has(node.id)) issues.push({ code: "duplicate_node_id", message: `Duplicate diagram node id '${node.id}'.`, severity: "error", nodeId: node.id });
    nodeIds.add(node.id);
    if (!node.label.trim()) issues.push({ code: "empty_node_label", message: `Diagram node '${node.id}' has an empty label.`, severity: "error", nodeId: node.id });
    for (const evidence of node.evidence) {
      if (!evidence.path.trim()) issues.push({ code: "empty_evidence_path", message: `Diagram node '${node.id}' has an empty evidence path.`, severity: "error", nodeId: node.id });
    }
  }
  const relationIds = new Set<string>();
  for (const relation of diagram.relations) {
    if (relationIds.has(relation.id)) issues.push({ code: "duplicate_relation_id", message: `Duplicate diagram relation id '${relation.id}'.`, severity: "error", relationId: relation.id });
    relationIds.add(relation.id);
    if (!nodeIds.has(relation.from) || !nodeIds.has(relation.to)) {
      issues.push({ code: "dangling_relation", message: `Relation '${relation.id}' references a missing node.`, severity: "error", relationId: relation.id });
    }
  }
  for (const node of diagram.nodes) {
    if (node.parentId && !nodeIds.has(node.parentId)) issues.push({ code: "missing_parent", message: `Node '${node.id}' references missing parent '${node.parentId}'.`, severity: "error", nodeId: node.id });
  }
  return issues;
}

export function validationStatus(issues: readonly DiagramValidationIssue[]): DiagramValidationStatus {
  if (issues.some((issue) => issue.severity === "error")) return "failed";
  if (issues.some((issue) => issue.severity === "warning")) return "warning";
  return "passed";
}
