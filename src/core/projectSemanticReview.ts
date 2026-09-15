import type { ProjectDiagram } from "./projectDiagram.js";
import type { ProjectIntent, ProjectIntentReview, ProjectIntentFreshness } from "./projectIntent.js";

export type SemanticIntentCollection = "brief" | "capabilities" | "contexts" | "flows" | "terms" | "constraints" | "decisions";
export type SemanticDecision = "accepted" | "rejected" | "edited";
export type SemanticDiagramItem = "diagram" | "node" | "relation";

export interface SemanticReviewRecord {
  itemId: string;
  collection: SemanticIntentCollection | SemanticDiagramItem;
  decision: SemanticDecision;
  decidedAt: number;
  baseVersion?: number;
  edited?: Record<string, unknown>;
}

export interface SemanticUpdateProposal {
  id: string;
  itemId: string;
  collection: SemanticIntentCollection | SemanticDiagramItem;
  changedPaths: string[];
  createdAt: number;
  /** Snapshot marker used to prevent a stale proposal overwriting a newer review. */
  baseVersion: number;
  previousReview: ProjectIntentReview | SemanticDecision | "draft";
  previousFreshness: ProjectIntentFreshness | "current";
  status: "needs_verification";
  reason: string;
}

function decisionFields(decision: SemanticDecision): { review: ProjectIntentReview } {
  return { review: decision };
}

function editable(values: Record<string, unknown>): Record<string, unknown> {
  const result = { ...values };
  delete result.id;
  delete result.schemaVersion;
  return result;
}

/** Reviews one Project Intent item while retaining its provenance and evidence. */
export function reviewProjectIntentItem(intent: ProjectIntent, collection: SemanticIntentCollection, itemId: string, decision: SemanticDecision, edited: Record<string, unknown> = {}, now = Date.now()): ProjectIntent {
  const result = structuredClone(intent);
  if (collection === "brief") {
    if (itemId !== "brief") return result;
    result.brief = { ...result.brief, ...editable(edited), ...decisionFields(decision) };
    return { ...result, updatedAt: now };
  }
  const values = result[collection] as Array<Record<string, unknown>>;
  const index = values.findIndex((item) => item.id === itemId);
  if (index < 0) return result;
  values[index] = { ...values[index], ...editable(edited), ...decisionFields(decision) };
  return { ...result, updatedAt: now };
}

/** Reviews a diagram, node or relation using stable Project IDs. */
export function reviewProjectDiagramItem(diagram: ProjectDiagram, itemId: string, decision: SemanticDecision, edited: Record<string, unknown> = {}, now = Date.now()): ProjectDiagram {
  const result = structuredClone(diagram);
  const fields = decisionFields(decision);
  if (itemId === diagram.id) return { ...result, ...editable(edited), ...fields, updatedAt: now } as ProjectDiagram;
  const node = result.nodes.find((item) => item.id === itemId);
  if (node) { Object.assign(node, editable(edited), fields); return result; }
  const relation = result.relations.find((item) => item.id === itemId);
  if (relation) Object.assign(relation, editable(edited), fields);
  return result;
}

/** Merges multiple Intent items into one reviewed item, preserving evidence and aliases. */
export function mergeProjectIntentItems(intent: ProjectIntent, collection: Exclude<SemanticIntentCollection, "brief">, itemIds: readonly string[], mergedId: string, patch: Record<string, unknown> = {}, now = Date.now()): ProjectIntent {
  const result = structuredClone(intent);
  const values = result[collection] as Array<Record<string, unknown>>;
  const sources = itemIds.map((id) => values.find((item) => item.id === id)).filter((item): item is Record<string, unknown> => Boolean(item));
  if (sources.length < 2 || values.some((item) => item.id === mergedId)) return result;
  const mergeArrays = (key: string): unknown[] => {
    const values = sources.flatMap((item) => { const value = item[key]; return Array.isArray(value) ? value as unknown[] : []; });
    return [...new Set(values)];
  };
  const first = sources[0]!;
  const patchAliases = Array.isArray(patch.aliases) ? patch.aliases as unknown[] : [];
  const merged: Record<string, unknown> = { ...first, ...editable(patch), id: mergedId, aliases: [...new Set([...mergeArrays("aliases"), ...patchAliases])], outcomes: mergeArrays("outcomes"), responsibilities: mergeArrays("responsibilities"), moduleIds: mergeArrays("moduleIds"), contextIds: mergeArrays("contextIds"), evidence: mergeArrays("evidence"), review: "edited", freshness: "current", generatedAt: now };
  result[collection] = [...values.filter((item) => !itemIds.includes(String(item.id))), merged] as never;
  return { ...result, updatedAt: now };
}

function changedSet(paths: readonly string[]): Set<string> { return new Set(paths.map((path) => path.replaceAll("\\", "/"))); }
function evidencePaths(item: { evidence?: readonly { path: string }[] }): string[] { return (item.evidence ?? []).map((entry) => entry.path.replaceAll("\\", "/")); }

function proposal(id: string, itemId: string, collection: SemanticUpdateProposal["collection"], changedPaths: readonly string[], baseVersion: number, previousReview: SemanticUpdateProposal["previousReview"], previousFreshness: SemanticUpdateProposal["previousFreshness"], now: number): SemanticUpdateProposal {
  return { id, itemId, collection, changedPaths: [...changedPaths].sort(), createdAt: now, baseVersion, previousReview, previousFreshness, status: "needs_verification", reason: "Source evidence changed after this semantic item was generated." };
}

export interface SemanticRefreshResult { intent: ProjectIntent; diagrams: ProjectDiagram[]; affectedIds: string[]; proposals: SemanticUpdateProposal[]; }

/** Marks only evidence-dependent semantic items stale; accepted/rejected decisions are retained. */
export function refreshSemanticFreshness(intent: ProjectIntent, diagrams: readonly ProjectDiagram[], changedPaths: readonly string[], now = Date.now()): SemanticRefreshResult {
  const changed = changedSet(changedPaths); const affectedIds: string[] = []; const proposals: SemanticUpdateProposal[] = [];
  const result = structuredClone(intent); const mark = (item: Record<string, unknown>, id: string, collection: SemanticUpdateProposal["collection"], baseVersion: number): void => {
    const directPaths = evidencePaths(item as { evidence?: readonly { path: string }[] });
    const nestedSteps = collection === "flows" && Array.isArray(item.steps) ? (item.steps as Array<Record<string, unknown>>).flatMap((step) => evidencePaths(step as { evidence?: readonly { path: string }[] })) : [];
    const paths = [...new Set([...directPaths, ...nestedSteps].filter((path) => changed.has(path)))];
    if (!paths.length) return;
    const previousFreshness = (item.freshness as SemanticUpdateProposal["previousFreshness"] | undefined) ?? "current";
    item.freshness = "needs_verification"; affectedIds.push(id);
    proposals.push(proposal(`refresh-${collection}-${id}-${baseVersion}`, id, collection, paths, baseVersion, (item.review as SemanticUpdateProposal["previousReview"] | undefined) ?? "accepted", previousFreshness, now));
  };
  mark(result.brief as unknown as Record<string, unknown>, "brief", "brief", intent.updatedAt);
  for (const collection of ["capabilities", "contexts", "flows", "terms", "constraints", "decisions"] as const) for (const item of result[collection]) mark(item as unknown as Record<string, unknown>, item.id, collection, intent.updatedAt);
  const refreshedDiagrams = structuredClone(diagrams);
  for (const diagram of refreshedDiagrams) {
    mark(diagram as unknown as Record<string, unknown>, diagram.id, "diagram", diagram.version);
    for (const node of diagram.nodes) mark(node as unknown as Record<string, unknown>, node.id, "node", diagram.version);
    for (const relation of diagram.relations) mark(relation as unknown as Record<string, unknown>, relation.id, "relation", diagram.version);
    // A diagram is stale when one of its child nodes/relations changes, even when the diagram
    // itself has no duplicate evidence entry. This keeps the rendered artifact from appearing
    // current while one of its semantic components awaits review.
    const childPaths = [...diagram.nodes, ...diagram.relations].flatMap((item) => evidencePaths(item)).filter((path) => changed.has(path));
    if (childPaths.length && diagram.freshness !== "needs_verification") {
      const previousFreshness = diagram.freshness ?? "current";
      diagram.freshness = "needs_verification";
      affectedIds.push(diagram.id);
      proposals.push(proposal(`refresh-diagram-${diagram.id}-${diagram.version}`, diagram.id, "diagram", [...new Set(childPaths)], diagram.version, diagram.review ?? "draft", previousFreshness, now));
    }
  }
  const intentIds = new Set([...intent.capabilities, ...intent.contexts, ...intent.flows, ...intent.terms, ...intent.constraints, ...intent.decisions].map((item) => item.id));
  const intentChanged = affectedIds.some((id) => id === "brief" || intentIds.has(id));
  return { intent: { ...result, ...(intentChanged ? { updatedAt: now } : {}) }, diagrams: [...refreshedDiagrams], affectedIds: [...new Set(affectedIds)], proposals };
}

/** Returns a review record only when the caller's base version still matches. */
export function createSemanticReviewRecord(itemId: string, collection: SemanticReviewRecord["collection"], decision: SemanticDecision, baseVersion?: number, edited?: Record<string, unknown>, now = Date.now()): SemanticReviewRecord {
  return { itemId, collection, decision, decidedAt: now, ...(baseVersion === undefined ? {} : { baseVersion }), ...(edited ? { edited } : {}) };
}
