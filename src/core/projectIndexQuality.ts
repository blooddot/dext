import type { ProjectContext, ProjectIntent, ProjectQualityIssue } from "./projectIntent.js";
import type { StructureMember } from "./projectStructure.js";
import { systemContextRelationships } from "./projectC4.js";

/** A review signal, never an automatic ownership rewrite or proof of incorrect behavior. */
export function ownershipConcerns(contexts: readonly ProjectContext[], files: readonly StructureMember[]): ProjectQualityIssue[] {
  const owners = new Map(contexts.flatMap(context => (context.sourceFiles ?? []).map(path => [path, context] as const)));
  const consumers = new Map<string, string[]>();
  for (const file of files) for (const edge of file.dependencies) if (edge.to && !edge.typeOnly) {
    consumers.set(edge.to, [...new Set([...(consumers.get(edge.to) ?? []), file.path])]);
  }
  return files.flatMap(file => {
    const owner = owners.get(file.path), usedBy = consumers.get(file.path) ?? [];
    if (!owner || (owner.sourceFiles?.length ?? 0) < 2 || file.symbols.length > 3 || usedBy.length !== 1) return [];
    const consumer = owners.get(usedBy[0]!);
    if (!consumer || consumer.id === owner.id || file.dependencies.some(edge => !edge.typeOnly && edge.to && owners.get(edge.to)?.id === owner.id)) return [];
    return [{ code: "ownership-review", message: `${file.path} is grouped under '${owner.canonicalName}', but its only non-type import consumer is ${usedBy[0]} in '${consumer.canonicalName}'. Review the responsibility boundary; imports alone do not prove ownership.`,
      contextIds: [owner.id, consumer.id], elementIds: [], sourcePaths: [file.path, usedBy[0]!] }];
  });
}

/** Semantic review signals remain separate from schema/reference validation. */
export function projectIndexQuality(intent: ProjectIntent, files: readonly StructureMember[]): ProjectQualityIssue[] {
  const issues = ownershipConcerns(intent.contexts, files);
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
