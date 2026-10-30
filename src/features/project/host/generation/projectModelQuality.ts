import type { ProjectContext, ProjectIntent, ProjectQualityIssue } from "../../contracts/projectIntent.js";
import type { ProjectModel } from "../../contracts/projectModel.js";
import { systemContextRelationships } from "../../presentation/projectC4.js";
import type { StructureMember } from "../indexing/projectStructure.js";
import { buildStructureGraphFromMembers, structureConsumers, type StructureGraph } from "../indexing/projectStructureGraph.js";

/** A review signal, never an automatic ownership rewrite or proof of incorrect behavior. */
export function ownershipConcerns(contexts: readonly ProjectContext[], files: readonly StructureMember[]): ProjectQualityIssue[] {
  const owners = new Map(contexts.flatMap(context => (context.sourceFiles ?? []).map(path => [path, context] as const)));
  const graph = buildStructureGraphFromMembers(files);
  return files.flatMap(file => {
    const owner = owners.get(file.path), usedBy = structureConsumers(graph, file.path, { typeOnly: false });
    if (!owner || (owner.sourceFiles?.length ?? 0) < 2 || file.symbols.length > 3 || usedBy.length !== 1) return [];
    const consumer = owners.get(usedBy[0]!);
    if (!consumer || consumer.id === owner.id || file.dependencies.some(edge => !edge.typeOnly && edge.to && owners.get(edge.to)?.id === owner.id)) return [];
    return [{ code: "ownership-review", message: `${file.path} is grouped under '${owner.canonicalName}', but its only non-type import consumer is ${usedBy[0]} in '${consumer.canonicalName}'. Review the responsibility boundary; imports alone do not prove ownership.`,
      contextIds: [owner.id, consumer.id], elementIds: [], sourcePaths: [file.path, usedBy[0]!] }];
  });
}

/** A community spread across more responsibilities than this describes the whole application, not one reviewable boundary. */
const COMMUNITY_REVIEW_MAX_MODULES = 8;

/**
 * Community structure is a review signal only: it never rewrites AI ownership or overrides the
 * one-owner-per-file validation. Small graphs and small contexts stay quiet, so a helper or a
 * three-file fixture cannot manufacture a split/merge warning.
 */
function communityConcerns(contexts: readonly ProjectContext[], graph: StructureGraph): ProjectQualityIssue[] {
  const owners = new Map(contexts.flatMap(context => (context.sourceFiles ?? []).map(path => [path, context] as const)));
  const communityOf = new Map<string, string>();
  for (const community of graph.communities) for (const path of community.files) communityOf.set(path, community.id);
  const sizeOf = new Map(graph.communities.map(community => [community.id, community.files.length]));
  const issues: ProjectQualityIssue[] = [];
  const seen = new Set<string>();

  for (const community of graph.communities) {
    if (community.files.length < 4) continue;
    const counts = new Map<string, number>();
    for (const path of community.files) { const owner = owners.get(path); if (owner) counts.set(owner.id, (counts.get(owner.id) ?? 0) + 1); }
    if (counts.size < 3 || counts.size > COMMUNITY_REVIEW_MAX_MODULES) continue;
    const [largest, count] = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]!;
    if (count / community.files.length >= 0.6) continue;
    const key = `community-split:${community.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sample = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 5).map(([id]) => id);
    issues.push({ code: "community-split",
      message: `Files that import each other form one graph community, but they are split across ${counts.size} responsibility modules (largest: '${contexts.find(context => context.id === largest)?.canonicalName ?? largest}'). Compare the module boundaries with these tightly coupled files; the graph is a navigation signal, not proof that the split is wrong.`,
      contextIds: sample, elementIds: [], sourcePaths: community.files.slice(0, 8) });
  }

  for (const context of contexts) {
    const files = context.sourceFiles ?? [];
    if (files.length < 4) continue;
    const counts = new Map<string, number>();
    for (const path of files) {
      const community = communityOf.get(path);
      if (!community || (sizeOf.get(community) ?? 0) < 2) continue;
      counts.set(community, (counts.get(community) ?? 0) + 1);
    }
    if (counts.size < 2) continue;
    // Isolated files (type-only imports, unresolved specifiers) form single-file communities without community evidence, so they do not count towards the fragmentation ratio.
    const attributed = [...counts.values()].reduce((total, value) => total + value, 0);
    if (attributed < 4) continue;
    const [largest] = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]!;
    if ((counts.get(largest) ?? 0) / attributed >= 0.6) continue;
    issues.push({ code: "module-fragmentation",
      message: `'${context.canonicalName}' spans ${counts.size} import communities, and its largest cohesive group is ${counts.get(largest) ?? 0}/${attributed} files. Check whether distinct features were merged into one module; this is a review signal, not an ownership error.`,
      contextIds: [context.id], elementIds: [], sourcePaths: files.slice(0, 8) });
  }

  const candidates = graph.edges.filter(edge => !edge.typeOnly && edge.count >= 3)
    .map(edge => ({ edge, from: owners.get(edge.from), to: owners.get(edge.to), fromCommunity: communityOf.get(edge.from), toCommunity: communityOf.get(edge.to) }))
    .filter(item => item.from && item.to && item.from.id !== item.to.id && item.fromCommunity && item.toCommunity && item.fromCommunity !== item.toCommunity)
    .sort((left, right) => right.edge.count - left.edge.count || left.edge.from.localeCompare(right.edge.from) || left.edge.to.localeCompare(right.edge.to));
  for (const item of candidates.slice(0, 5)) {
    const key = `${item.from!.id}->${item.to!.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ code: "surprising-dependency",
      message: `'${item.from!.canonicalName}' depends on '${item.to!.canonicalName}' across separate import communities (${item.edge.count} import${item.edge.count === 1 ? "" : "s"}). Confirm the direction and whether the dependency crosses a responsibility boundary for a reason.`,
      contextIds: [item.from!.id, item.to!.id], elementIds: [], sourcePaths: [item.edge.from, item.edge.to] });
  }
  return issues;
}

/** Semantic review signals remain separate from schema/reference validation. */
export function projectModelQuality(intent: ProjectIntent, files: readonly StructureMember[], reviews: readonly ProjectQualityIssue[] = []): ProjectQualityIssue[] {
  const issues = ownershipConcerns(intent.contexts, files).map(issue => reviews.find(review => review.sourcePaths[0] === issue.sourcePaths[0]) ?? { ...issue, status: "unresolved" as const });
  for (const review of reviews) if (!issues.some(issue => issue.sourcePaths[0] === review.sourcePaths[0])) issues.push(review);
  issues.push(...communityConcerns(intent.contexts, buildStructureGraphFromMembers(files)));
  const model = intent.c4;
  if (!model) return issues;
  const contextEdges = systemContextRelationships(model);
  for (const element of model.elements) {
    const edges = element.kind === "container" ? model.relationships : contextEdges;
    if (!edges.some(edge => edge.from === element.id || edge.to === element.id)) issues.push({ code: "isolated-c4-element",
      message: `'${element.name}' has no relationship in its architecture view. Verify the boundary evidence or add a supported interaction.`,
      contextIds: element.contextIds, elementIds: [element.id], sourcePaths: element.evidence.map(item => item.path) });
    if (element.kind === "container" && element.parentId === model.systemId && !element.contextIds.length) issues.push({ code: "missing-context-mapping",
      message: `Runtime unit '${element.name}' has no linked knowledge module. Its implementation cannot be reached from the architecture view.`,
      contextIds: [], elementIds: [element.id], sourcePaths: element.evidence.map(item => item.path) });
  }
  return issues;
}

/**
 * Stores review signals on the model root, which is where the read view surfaces them again. The
 * native model is the only writer, so a route that drafts a model must record them here.
 */
export function withProjectQuality(model: ProjectModel, issues: readonly ProjectQualityIssue[]): ProjectModel {
  const root = model.nodes.find(node => node.kind === "project");
  if (!root) return model;
  const properties = { ...root.properties };
  delete properties.qualityIssues;
  return { ...model, nodes: model.nodes.map(node => node === root
    ? { ...node, properties: issues.length ? { ...properties, qualityIssues: [...issues] } : properties }
    : node) };
}
