import type { ProjectDiagram } from "../contracts/projectDiagram.js";
import type { ProjectContext, ProjectIntent } from "../contracts/projectIntent.js";

/** Older analyses already snapshot their exact module membership in the versioned topic basis. */
export function analysisSourceFiles(diagram: ProjectDiagram): string[] {
  if (diagram.metadata?.topicAnalysis !== 1 || typeof diagram.metadata.topicBasis !== "string") return [];
  try {
    const basis: unknown = JSON.parse(diagram.metadata.topicBasis);
    if (!Array.isArray(basis) || basis.length !== 7 || basis[0] !== diagram.metadata.topicId || !Array.isArray(basis[6])) return [];
    const paths: unknown[] = basis[6];
    return paths.every(path => typeof path === "string" && path.length > 0) ? paths as string[] : [];
  } catch { return []; }
}

const overlaps = (a: readonly string[], b: readonly string[]): boolean => a.some(path => b.includes(path));

/** Preserve unambiguous continuations; split/merged boundaries retain history without adopting it. */
export function reconcileProjectModel(next: ProjectIntent, previous: ProjectIntent | undefined, diagrams: readonly ProjectDiagram[]): ProjectIntent {
  const old = previous?.contexts.filter(context => context.sourceFiles?.length) ?? [];
  const incoming = next.contexts;
  const predecessors = new Map(incoming.map(context => [context.id, old.filter(item => overlaps(context.sourceFiles ?? [], item.sourceFiles!))]));
  const successors = new Map(old.map(context => [context.id, incoming.filter(item => overlaps(context.sourceFiles!, item.sourceFiles ?? []))]));
  const remap = new Map<string, string>();
  for (const context of incoming) {
    const matches = predecessors.get(context.id)!;
    const prior = matches.length === 1 ? matches[0] : undefined;
    if (!prior || successors.get(prior.id)!.length !== 1) continue;
    const members = new Set(context.sourceFiles ?? []), oldMembers = new Set(prior.sourceFiles);
    const intersection = [...members].filter(path => oldMembers.has(path)).length;
    if (intersection / new Set([...members, ...oldMembers]).size < 0.5) continue;
    if (incoming.some(item => item.id === prior.id && item.id !== context.id)) continue;
    remap.set(context.id, prior.id);
  }
  const idOf = (id: string) => remap.get(id) ?? id;
  const contexts: ProjectContext[] = incoming.map(context => {
    const history = new Set([
      ...(context.previousContextIds ?? []),
      ...predecessors.get(context.id)!.flatMap(item => [item.id, ...(item.previousContextIds ?? [])]),
      ...diagrams.filter(diagram => overlaps(context.sourceFiles ?? [], analysisSourceFiles(diagram)))
        .flatMap(diagram => typeof diagram.metadata?.topicId === "string" ? [diagram.metadata.topicId] : [])
    ]);
    history.delete(idOf(context.id));
    return { ...context, id: idOf(context.id), dependsOn: context.dependsOn.map(idOf), relatedContextIds: context.relatedContextIds.map(idOf),
      ...(history.size ? { previousContextIds: [...history].sort() } : {}) };
  });
  return { ...next, contexts,
    ...(next.qualityIssues ? { qualityIssues: next.qualityIssues.map(issue => ({ ...issue, contextIds: issue.contextIds.map(idOf) })) } : {}),
    capabilities: next.capabilities.map(item => ({ ...item, contextIds: item.contextIds.map(idOf) })),
    flows: next.flows.map(item => ({ ...item, steps: item.steps.map(step => ({ ...step, ...(step.contextId ? { contextId: idOf(step.contextId) } : {}) })) })),
    terms: next.terms.map(item => ({ ...item, contextIds: item.contextIds.map(idOf) })),
    constraints: next.constraints.map(item => ({ ...item, scope: item.scope.map(idOf) })),
    ...(next.c4 ? { c4: { ...next.c4, elements: next.c4.elements.map(item => ({ ...item, contextIds: item.contextIds.map(idOf) })) } } : {})
  };
}
