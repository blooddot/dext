/** Diagram kinds understood by Project's Archify adapter protocol. */
export type ProjectDiagramKind = "architecture" | "workflow" | "sequence" | "data_flow" | "lifecycle" | "tree" | "class";

/** Semantic roles are intentionally renderer-neutral. Archify maps them to its own component types. */
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
  /** Workspace-relative path; absolute paths and traversal are never accepted. */
  path: string;
  symbol?: string;
  line?: number;
  note?: string;
  contentHash?: string;
}

export type ProjectDiagramClassKind = "class" | "abstract" | "interface" | "enum" | "record";

/** A class/type member. Only explicit declarations are recorded; members are never inferred. */
export interface ProjectDiagramMember {
  name: string;
  kind: "attribute" | "method";
  type?: string;
  parameters?: string;
  returns?: string;
  visibility?: "public" | "protected" | "package" | "private";
  static?: boolean;
  abstract?: boolean;
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
  /** Workflow lane id. Only meaningful for workflow diagrams. */
  laneId?: string;
  /** Data-flow stage id. Only meaningful for data-flow diagrams. */
  stageId?: string;
  /** Tree/class diagrams are derived locally from the structure index, never AI-generated. */
  classKind?: ProjectDiagramClassKind;
  members?: readonly ProjectDiagramMember[];
  /** Ids of Project knowledge objects or stable ids from this AI output. */
  semanticIds: readonly string[];
  evidence: readonly ProjectDiagramEvidence[];
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export type ProjectDiagramRelationKind =
  | "calls"
  | "returns"
  | "depends_on"
  | "contains"
  | "reads"
  | "writes"
  | "publishes"
  | "subscribes"
  | "transitions"
  | "flows_to"
  | "inheritance"
  | "realization"
  | "unknown";

export interface ProjectDiagramRelation {
  review?: "draft" | "accepted" | "rejected" | "edited";
  freshness?: "current" | "needs_verification" | "stale" | "conflicted";
  confidence?: number;
  id: string;
  from: string;
  to: string;
  kind: ProjectDiagramRelationKind;
  label?: string;
  /** Explicit sequence/order. Never inferred from array position. */
  order?: number;
  /** Branch guard or state-transition condition. */
  condition?: string;
  /** True when the relation describes an exception/error path. */
  exception?: boolean;
  evidence: readonly ProjectDiagramEvidence[];
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** Architecture grouping/boundary. `nodeIds` must reference existing nodes. */
export interface ProjectDiagramBoundary {
  id: string;
  label: string;
  kind?: "region" | "security-group";
  nodeIds: readonly string[];
  evidence: readonly ProjectDiagramEvidence[];
}

/** Workflow swimlane. */
export interface ProjectDiagramLane {
  id: string;
  label: string;
  variant?: "normal" | "exception";
  evidence: readonly ProjectDiagramEvidence[];
}

/** Workflow stage/phase column range (0-5), mapped to the upstream grouped layout. */
export interface ProjectDiagramPhase {
  id: string;
  label: string;
  fromCol: number;
  toCol: number;
  evidence: readonly ProjectDiagramEvidence[];
}

/** Workflow grouped-layout region inside one lane. */
export interface ProjectDiagramGroup {
  id: string;
  label: string;
  laneId: string;
  fromCol: number;
  toCol: number;
  evidence: readonly ProjectDiagramEvidence[];
}

/** Data-flow processing stage. Nodes reference it through `stageId`. */
export interface ProjectDiagramStage {
  id: string;
  label: string;
  order: number;
  evidence: readonly ProjectDiagramEvidence[];
}

/** Sequence participant with an explicit order; participants are ordinary diagram nodes. */
export interface ProjectDiagramParticipant {
  nodeId: string;
  order: number;
}

export interface ProjectDiagramMessage {
  relationId: string;
  order: number;
  kind: "call" | "return";
  condition?: string;
  evidence: readonly ProjectDiagramEvidence[];
}

/** Initial/terminal/normal state classification for lifecycle diagrams. */
export interface ProjectDiagramState {
  nodeId: string;
  kind: "initial" | "terminal" | "normal";
  /** Terminal outcome; ignored for initial and normal states. */
  outcome?: "success" | "failure";
  evidence: readonly ProjectDiagramEvidence[];
}

export interface ProjectDiagramTransition {
  relationId: string;
  event?: string;
  condition?: string;
  evidence: readonly ProjectDiagramEvidence[];
}

/**
 * Optional per-kind structures. Properties that are not evidenced stay unset rather than being
 * derived from node/relation array order. Missing structures are treated as unknown semantics.
 */
export interface ProjectDiagramSemantics {
  /** architecture: grouping and boundaries around component nodes. */
  boundaries?: readonly ProjectDiagramBoundary[];
  /** workflow: swimlanes and their ordered steps. */
  lanes?: readonly ProjectDiagramLane[];
  /** workflow: ordered column ranges for grouped layout. */
  phases?: readonly ProjectDiagramPhase[];
  groups?: readonly ProjectDiagramGroup[];
  /** workflow: explicit main success path of node ids. */
  mainPath?: readonly string[];
  /** sequence: participant order. */
  participants?: readonly ProjectDiagramParticipant[];
  /** sequence: message order and call/return classification. */
  messages?: readonly ProjectDiagramMessage[];
  /** data_flow: processing stages. */
  stages?: readonly ProjectDiagramStage[];
  /** lifecycle: initial/terminal classification, events and conditions. */
  states?: readonly ProjectDiagramState[];
  transitions?: readonly ProjectDiagramTransition[];
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
  /** Optional per-kind structures; legacy diagrams without them stay readable. */
  semantics?: ProjectDiagramSemantics;
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

const WORKFLOW_COLUMN_LIMIT = 5;

/**
 * Validates renderer-independent invariants plus the optional semantic structures.
 * Missing optional structures produce warnings, never hard errors, so legacy saved diagrams remain
 * readable; requiring kind-specific semantics is the AI schema's job.
 */
export function validateProjectDiagram(diagram: ProjectDiagram): DiagramValidationIssue[] {
  const issues: DiagramValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const nodeById = new Map<string, ProjectDiagramNode>();
  for (const node of diagram.nodes) {
    if (nodeIds.has(node.id)) issues.push({ code: "duplicate_node_id", message: `Duplicate diagram node id '${node.id}'.`, severity: "error", nodeId: node.id });
    nodeIds.add(node.id);
    if (!nodeById.has(node.id)) nodeById.set(node.id, node);
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
    for (const evidence of relation.evidence) {
      if (!evidence.path.trim()) issues.push({ code: "empty_evidence_path", message: `Diagram relation '${relation.id}' has an empty evidence path.`, severity: "error", relationId: relation.id });
    }
  }
  for (const node of diagram.nodes) {
    if (node.parentId && !nodeIds.has(node.parentId)) issues.push({ code: "missing_parent", message: `Node '${node.id}' references missing parent '${node.parentId}'.`, severity: "error", nodeId: node.id });
  }
  if (diagram.kind === "tree") {
    const roots = diagram.nodes.filter((node) => !node.parentId);
    if (roots.length !== 1) issues.push({ code: "tree_root_count", message: `A tree diagram needs exactly one root node; found ${roots.length}.`, severity: "error", ...(roots.length === 1 ? { nodeId: roots[0]!.id } : {}) });
    const cyclic = new Set<string>();
    for (const node of diagram.nodes) {
      const chain = new Set<string>();
      let cursor: string | undefined = node.id;
      while (cursor && nodeById.has(cursor)) {
        if (chain.has(cursor)) {
          for (const id of chain) cyclic.add(id);
          break;
        }
        chain.add(cursor);
        cursor = nodeById.get(cursor)?.parentId;
      }
    }
    for (const id of [...cyclic].sort()) issues.push({ code: "tree_parent_cycle", message: `Node '${id}' is part of a parent cycle.`, severity: "error", nodeId: id });
  }
  if (diagram.kind === "class") {
    const inheritanceEdges: Array<{ from: string; to: string; id: string }> = [];
    for (const node of diagram.nodes) {
      for (const member of node.members ?? []) {
        if (!member.name.trim()) issues.push({ code: "empty_class_member", message: `Class node '${node.id}' has a member with an empty name.`, severity: "error", nodeId: node.id });
      }
      const names = (node.members ?? []).map((member) => `${member.kind}:${member.name}`);
      if (new Set(names).size !== names.length) issues.push({ code: "duplicate_class_member", message: `Class node '${node.id}' declares the same member twice.`, severity: "warning", nodeId: node.id });
    }
    for (const relation of diagram.relations) {
      if (relation.kind !== "inheritance" && relation.kind !== "realization") continue;
      const from = nodeById.get(relation.from);
      const to = nodeById.get(relation.to);
      if (!from || !to) continue;
      if (relation.from === relation.to) issues.push({ code: "self_class_relationship", message: `Class relationship '${relation.id}' connects '${relation.from}' to itself.`, severity: "error", relationId: relation.id });
      if (!from.classKind || !to.classKind) issues.push({ code: "invalid_class_relationship", message: `Class relationship '${relation.id}' must connect two typed class nodes.`, severity: "error", relationId: relation.id });
      if (relation.kind === "realization" && to.classKind !== "interface") issues.push({ code: "invalid_realization_target", message: `Realization '${relation.id}' must target an interface.`, severity: "error", relationId: relation.id });
      if (relation.kind === "inheritance" && to.classKind === "interface") issues.push({ code: "invalid_inheritance_target", message: `Inheritance '${relation.id}' must not target an interface.`, severity: "error", relationId: relation.id });
      if (relation.kind === "inheritance" && relation.from !== relation.to) inheritanceEdges.push({ from: relation.from, to: relation.to, id: relation.id });
    }
    const outgoing = new Map<string, string[]>();
    for (const edge of inheritanceEdges) {
      const next = outgoing.get(edge.from) ?? [];
      next.push(edge.to);
      outgoing.set(edge.from, next);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) { cycles.add(id); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const next of outgoing.get(id) ?? []) visit(next);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of outgoing.keys()) visit(id);
    for (const id of [...cycles].sort()) issues.push({ code: "class_inheritance_cycle", message: `Class inheritance contains a cycle through '${id}'.`, severity: "error", nodeId: id });
  }
  const semantics = diagram.semantics ?? {};
  const requireNodes = (code: string, label: string, ids: readonly string[]): void => {
    for (const id of ids) if (!nodeIds.has(id)) issues.push({ code, message: `${label} references missing node '${id}'.`, severity: "error" });
  };
  const requireRelations = (code: string, label: string, ids: readonly string[]): void => {
    for (const id of ids) if (!relationIds.has(id)) issues.push({ code, message: `${label} references missing relation '${id}'.`, severity: "error" });
  };
  for (const boundary of semantics.boundaries ?? []) {
    if (!boundary.nodeIds.length) issues.push({ code: "empty_boundary", message: `Boundary '${boundary.id}' wraps no nodes.`, severity: "warning" });
    requireNodes("dangling_boundary_node", `Boundary '${boundary.id}'`, boundary.nodeIds);
  }
  const laneIds = new Set<string>();
  for (const lane of semantics.lanes ?? []) {
    if (laneIds.has(lane.id)) issues.push({ code: "duplicate_lane_id", message: `Duplicate lane id '${lane.id}'.`, severity: "error" });
    laneIds.add(lane.id);
  }
  for (const node of diagram.nodes) {
    if (node.laneId && !laneIds.has(node.laneId)) issues.push({ code: "dangling_lane", message: `Node '${node.id}' references missing lane '${node.laneId}'.`, severity: "error", nodeId: node.id });
  }
  const checkColumnRange = (code: string, message: string, from: number, to: number): void => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from > WORKFLOW_COLUMN_LIMIT || to > WORKFLOW_COLUMN_LIMIT || from > to) {
      issues.push({ code, message, severity: "error" });
    }
  };
  for (const phase of semantics.phases ?? []) checkColumnRange("invalid_phase_range", `Phase '${phase.id}' must span columns 0-${WORKFLOW_COLUMN_LIMIT} in ascending order.`, phase.fromCol, phase.toCol);
  for (const group of semantics.groups ?? []) {
    checkColumnRange("invalid_group_range", `Group '${group.id}' must span columns 0-${WORKFLOW_COLUMN_LIMIT} in ascending order.`, group.fromCol, group.toCol);
    if (!laneIds.has(group.laneId)) issues.push({ code: "dangling_group_lane", message: `Group '${group.id}' references missing lane '${group.laneId}'.`, severity: "error" });
  }
  if (semantics.mainPath) {
    if (semantics.mainPath.length < 2) issues.push({ code: "short_main_path", message: "Workflow mainPath must contain at least two nodes.", severity: "error" });
    if (new Set(semantics.mainPath).size !== semantics.mainPath.length) issues.push({ code: "duplicate_main_path_node", message: "Workflow mainPath must not repeat a node.", severity: "error" });
    requireNodes("dangling_main_path_node", "mainPath", semantics.mainPath);
  }
  const stageIds = new Set<string>();
  for (const stage of semantics.stages ?? []) {
    if (stageIds.has(stage.id)) issues.push({ code: "duplicate_stage_id", message: `Duplicate data-flow stage id '${stage.id}'.`, severity: "error" });
    stageIds.add(stage.id);
  }
  for (const node of diagram.nodes) {
    if (node.stageId && !stageIds.has(node.stageId)) issues.push({ code: "dangling_stage", message: `Node '${node.id}' references missing stage '${node.stageId}'.`, severity: "error", nodeId: node.id });
  }
  const participantNodes = new Set<string>();
  const participantOrders = new Set<number>();
  for (const participant of semantics.participants ?? []) {
    requireNodes("dangling_participant", "Participant", [participant.nodeId]);
    if (participantNodes.has(participant.nodeId)) issues.push({ code: "duplicate_participant", message: `Participant '${participant.nodeId}' appears twice.`, severity: "error", nodeId: participant.nodeId });
    participantNodes.add(participant.nodeId);
    if (participantOrders.has(participant.order)) issues.push({ code: "duplicate_participant_order", message: `Participant order ${participant.order} is used twice.`, severity: "error", nodeId: participant.nodeId });
    participantOrders.add(participant.order);
  }
  const messageOrders = new Set<number>();
  for (const message of semantics.messages ?? []) {
    requireRelations("dangling_message_relation", "Message", [message.relationId]);
    if (messageOrders.has(message.order)) issues.push({ code: "duplicate_message_order", message: `Message order ${message.order} is used twice.`, severity: "error", relationId: message.relationId });
    messageOrders.add(message.order);
  }
  const states = semantics.states ?? [];
  for (const state of states) {
    requireNodes("dangling_state_node", "State", [state.nodeId]);
    if (state.outcome && state.kind !== "terminal") issues.push({ code: "unexpected_state_outcome", message: "A non-terminal state declares an outcome.", severity: "warning", nodeId: state.nodeId });
  }
  const initialStates = states.filter((state) => state.kind === "initial");
  if (initialStates.length > 1) issues.push({ code: "multiple_initial_states", message: "A lifecycle diagram must not have more than one initial state.", severity: "error" });
  for (const transition of semantics.transitions ?? []) {
    requireRelations("dangling_transition_relation", "Transition", [transition.relationId]);
  }
  if (diagram.kind === "data_flow" && (semantics.stages?.length ?? 0) < 2) issues.push({ code: "missing_data_flow_stages", message: "A data-flow diagram needs at least two evidenced processing stages.", severity: "warning" });
  if (diagram.kind === "sequence" && (semantics.participants?.length ?? 0) < 2) issues.push({ code: "missing_sequence_participants", message: "A sequence diagram needs at least two evidenced participants.", severity: "warning" });
  if (diagram.kind === "workflow" && !(semantics.lanes?.length)) issues.push({ code: "missing_workflow_lanes", message: "A workflow diagram needs at least one evidenced lane.", severity: "warning" });
  if (diagram.kind === "lifecycle") {
    if (!initialStates.length) issues.push({ code: "missing_initial_state", message: "A lifecycle diagram needs an explicit initial state.", severity: "warning" });
    if (!states.some((state) => state.kind === "terminal")) issues.push({ code: "missing_lifecycle_states", message: "A lifecycle diagram needs at least one explicit terminal state.", severity: "warning" });
  }
  return issues;
}

export function validationStatus(issues: readonly DiagramValidationIssue[]): DiagramValidationStatus {
  if (issues.some((issue) => issue.severity === "error")) return "failed";
  if (issues.some((issue) => issue.severity === "warning")) return "warning";
  return "passed";
}
