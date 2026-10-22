import type { ProjectDiagram, ProjectDiagramEvidence } from "../contracts/projectDiagram.js";
import type { ProjectIntent, ProjectQualityIssue } from "../contracts/projectIntent.js";
import type { ProjectEvidence } from "../contracts/projectKnowledge.js";
import { buildC4Topics } from "../presentation/projectC4.js";
import { analysisSourceFiles } from "./projectModelEvolution.js";

const diagramEvidenceEntries = (entries: readonly ProjectEvidence[]): ProjectDiagramEvidence[] => entries.map((entry) => ({
  path: entry.path,
  ...(entry.symbol !== undefined ? { symbol: entry.symbol } : {}),
  ...(entry.line !== undefined ? { line: entry.line } : {}),
  ...(entry.note !== undefined ? { note: entry.note } : {}),
  ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {})
}));

export interface ProjectTopic {
  basis?: string;
  analysisState?: "outline" | "ready" | "stale";
  id: string;
  title: string;
  kind: "context" | "flow" | "system_context" | "containers" | "structure" | "types";
  description: string;
  responsibilities: string[];
  entryPoints: string[];
  sourceFiles?: string[];
  area?: { id: string; title: string; description: string };
  uncertainties?: string[];
  qualityWarnings?: string[];
  qualityIssues?: ProjectQualityIssue[];
  previousAnalyses?: { id: string; title: string }[];
  steps: string[];
  constraints: string[];
  evidence: ProjectEvidence[];
  diagrams: { id: string; title: string }[];
  review: string;
  generatedAt?: number;
  sections?: ProjectTopicSection[];
  relatedTopics?: { id: string; title: string }[];
  /** Derived from the same saved statements as the prose; never a separately inferred graph. */
  diagram?: ProjectDiagram;
}

export interface ProjectTopicSection {
  id: string;
  title: string;
  description: string;
  evidence: ProjectEvidence[];
  relatedTopicIds: string[];
}

export type ProjectEvidenceState = "unchanged" | "changed" | "missing" | "unknown";
export interface ProjectTopicCheck {
  id: string;
  /** Matches the exact saved evidence, so an old check cannot qualify a new topic. */
  fingerprint: string;
  checkedAt: number;
  state: ProjectEvidenceState;
  files: { path: string; state: ProjectEvidenceState }[];
}

export function topicFingerprint(topic: ProjectTopic): string {
  return JSON.stringify([topic.description, topic.responsibilities, topic.entryPoints, topic.steps, topic.constraints, topic.evidence, topic.sections, topic.diagram]);
}

/** A reading view over existing semantic IDs; no second knowledge store or inferred links. */
export function buildProjectTopics(intent: ProjectIntent, diagrams: readonly ProjectDiagram[] = []): ProjectTopic[] {
  const constraints = (ids: readonly string[]) => intent.constraints
    .filter((constraint) => constraint.scope.some((id) => ids.includes(id) || id === "*"));
  const related = (ids: readonly string[]) => diagrams
    .filter((diagram) => ids.includes(String(diagram.metadata?.topicId ?? "")) || diagram.nodes.some((node) => node.semanticIds.some((id) => ids.includes(id))));
  const relatedDiagrams = (ids: readonly string[]) => related(ids).map((diagram) => ({ id: diagram.id, title: diagram.title }));
  const diagramEvidence = (ids: readonly string[]) => related(ids).flatMap((diagram) => [...diagram.nodes.flatMap((node) => node.evidence), ...diagram.relations.flatMap((relation) => relation.evidence)]);
  const unique = (entries: readonly ProjectEvidence[]) => [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()];
  const topicName = (id: string) => {
    const item = [...intent.contexts, ...intent.flows].find((item) => item.id === id);
    return item ? [{ id, title: item.displayName ?? item.canonicalName }] : [];
  };
  const diagramBase = (id: string, title: string, kind: ProjectDiagram["kind"]): Pick<ProjectDiagram, "schemaVersion" | "id" | "title" | "kind" | "version" | "updatedAt" | "metadata"> => ({
    schemaVersion: 1, id: `topic-view:${id}`, title, kind, version: 0, updatedAt: intent.updatedAt, metadata: { topicId: id, derived: true }
  });
  const topics: ProjectTopic[] = [
    ...buildC4Topics(intent),
    ...intent.contexts.map((context): ProjectTopic => {
      const area = intent.capabilities.find(capability => capability.contextIds.includes(context.id));
      const previousAnalyses = diagrams.filter(diagram => diagram.metadata?.topicAnalysis === 1 && diagram.metadata.topicId !== context.id
        && (context.previousContextIds?.includes(String(diagram.metadata.topicId))
          || (!intent.contexts.some(item => item.id === diagram.metadata?.topicId)
            && analysisSourceFiles(diagram).some(path => context.sourceFiles?.includes(path)))));
      const scoped = constraints([context.id, ...context.moduleIds]);
      const collaborators = intent.contexts.filter((item) => context.dependsOn.includes(item.id));
      const section = { id: context.id, title: context.displayName ?? context.canonicalName, description: context.purpose, evidence: context.evidence, relatedTopicIds: [] };
      const diagram: ProjectDiagram = {
        ...diagramBase(context.id, context.displayName ?? context.canonicalName, "architecture"),
        nodes: [context, ...collaborators.filter((item) => item.id !== context.id)].map((item) => ({ id: item.id, label: item.displayName ?? item.canonicalName, role: "context", description: item.purpose, semanticIds: [item.id], evidence: diagramEvidenceEntries(item.evidence) })),
        relations: collaborators.map((item) => ({ id: `${context.id}->${item.id}`, from: context.id, to: item.id, kind: "depends_on", label: "depends on", evidence: diagramEvidenceEntries(context.evidence) }))
      };
      return {
        basis: JSON.stringify([context.id, context.purpose, context.entryPoints, context.evidence, context.structureHash, context.dependsOn, ...(context.sourceFiles ? [context.sourceFiles] : [])]),
        analysisState: context.detail === "outline" ? "outline" : "ready",
        id: context.id, title: context.displayName ?? context.canonicalName, kind: "context",
        ...(context.uncertainties?.length ? { uncertainties: context.uncertainties } : {}),
        ...(previousAnalyses.length ? { previousAnalyses: previousAnalyses.map(diagram => ({ id: diagram.id, title: diagram.title })) } : {}),
        ...(area ? { area: { id: area.id, title: area.displayName ?? area.canonicalName, description: area.description } } : {}),
        description: context.purpose, responsibilities: context.responsibilities,
        entryPoints: context.entryPoints, ...(context.sourceFiles ? { sourceFiles: context.sourceFiles } : {}), steps: [], constraints: scoped.map((item) => item.statement),
        evidence: unique([...context.evidence, ...scoped.flatMap((item) => item.evidence), ...collaborators.flatMap((item) => item.evidence), ...(context.detail === "outline" ? [] : diagramEvidence([context.id]))]),
        diagrams: relatedDiagrams([context.id]), review: context.review,
        sections: [section], ...(context.detail !== "outline" ? { diagram } : {}),
        relatedTopics: [...new Set([...context.dependsOn, ...context.relatedContextIds, ...intent.flows.filter((flow) => flow.steps.some((step) => step.contextId === context.id)).map((flow) => flow.id)])].filter((id) => id !== context.id).flatMap(topicName),
        ...(context.generatedAt ? { generatedAt: context.generatedAt } : {})
      };
    }),
    ...intent.flows.map((flow): ProjectTopic => {
      const ids = [flow.id, ...flow.steps.flatMap((step) => [step.contextId, step.moduleId].filter((id): id is string => Boolean(id)))];
      const scoped = constraints(ids);
      return {
        basis: JSON.stringify([flow.id, flow.description, flow.steps, flow.evidence]),
        analysisState: "ready",
        id: flow.id, title: flow.displayName ?? flow.canonicalName, kind: "flow",
        description: flow.description, responsibilities: flow.outcomes,
        entryPoints: flow.trigger ? [flow.trigger] : [], steps: flow.steps.map((step) => step.label),
        constraints: scoped.map((item) => item.statement),
        evidence: unique([...flow.evidence, ...flow.steps.flatMap((step) => step.evidence), ...scoped.flatMap((item) => item.evidence), ...diagramEvidence([flow.id, ...flow.steps.map((step) => step.id)])]),
        diagrams: relatedDiagrams([flow.id, ...flow.steps.map((step) => step.id)]), review: flow.review,
        sections: flow.steps.map((step) => ({ id: step.id, title: step.label, description: step.description ?? "", evidence: step.evidence, relatedTopicIds: step.contextId ? [step.contextId] : [] })),
        relatedTopics: [...new Set(flow.steps.flatMap((step) => step.contextId ? [step.contextId] : []))].flatMap(topicName),
        diagram: {
          ...diagramBase(flow.id, flow.displayName ?? flow.canonicalName, "workflow"),
          nodes: flow.steps.map((step) => ({ id: step.id, label: step.label, role: "step", laneId: "steps", description: step.description ?? "", semanticIds: [step.id, ...(step.contextId ? [step.contextId] : [])], evidence: diagramEvidenceEntries(step.evidence) })),
          semantics: { lanes: [{ id: "steps", label: "Steps", evidence: diagramEvidenceEntries(flow.evidence) }] },
          // Array order is a reading order, not proof of a transition.
          relations: flow.steps.flatMap((step) => step.nextStepIds.filter((id) => flow.steps.some((candidate) => candidate.id === id)).map((id) => ({ id: `${step.id}->${id}`, from: step.id, to: id, kind: "flows_to", evidence: diagramEvidenceEntries(step.evidence) })))
        },
        ...(flow.generatedAt ? { generatedAt: flow.generatedAt } : {})
      };
    })
  ];
  return topics.map(topic => {
    const warnings = (intent.qualityIssues ?? []).filter(issue => issue.contextIds.includes(topic.id)
      || ((topic.kind === "system_context" || topic.kind === "containers") && issue.elementIds.some(id => topic.diagram?.nodes.some(node => node.id === id))));
    if (warnings.length) topic = { ...topic, qualityIssues: warnings, qualityWarnings: warnings.filter(issue => !issue.status || issue.status === "unresolved").map(issue => issue.message), evidence: unique([...topic.evidence, ...warnings.flatMap(issue => issue.evidence ?? issue.sourcePaths.map(path => ({ path })))]) };
    const analysis = diagrams.filter(diagram => diagram.metadata?.topicId === topic.id && diagram.metadata.topicAnalysis === 1 && typeof diagram.metadata.topicSummary === "string")
      .sort((a, b) => b.updatedAt - a.updatedAt || b.version - a.version)[0];
    if (!analysis) return topic;
    const evidence = [...analysis.nodes.flatMap(node => node.evidence), ...analysis.relations.flatMap(edge => edge.evidence)];
    return { ...topic, analysisState: analysis.metadata?.topicBasis === topic.basis ? "ready" : "stale",
      description: String(analysis.metadata!.topicSummary), responsibilities: [],
      sections: analysis.nodes.map(node => ({ id: node.id, title: node.label, description: node.description ?? "", evidence: [...node.evidence],
        relatedTopicIds: node.semanticIds.filter(id => id !== topic.id && topics.some(item => item.id === id)) })),
      diagram: analysis, evidence: unique(evidence), generatedAt: analysis.updatedAt };
  });
}

/** Checks file snapshots, not semantic truth. Unknown evidence must never become verified. */
export async function checkProjectTopics(
  topics: readonly ProjectTopic[],
  snapshot: (path: string) => Promise<{ contentHash: string } | undefined>,
  now = Date.now()
): Promise<ProjectTopicCheck[]> {
  const snapshots = new Map<string, Promise<{ contentHash: string } | undefined>>();
  const read = (path: string) => {
    let result = snapshots.get(path);
    if (!result) { result = snapshot(path); snapshots.set(path, result); }
    return result;
  };
  const results: ProjectTopicCheck[] = [];
  for (const topic of topics) {
    const files: ProjectTopicCheck["files"] = [];
    for (const entry of topic.evidence) {
      let state: ProjectEvidenceState = "unknown";
      try {
        const current = await read(entry.path);
        state = !current ? "missing" : !entry.contentHash ? "unknown" : current.contentHash === entry.contentHash ? "unchanged" : "changed";
      } catch { /* Unreadable or over-budget files have unknown freshness. */ }
      files.push({ path: entry.path, state });
    }
    const state = files.some((file) => file.state === "missing") ? "missing"
      : files.some((file) => file.state === "changed") ? "changed"
        : !files.length || files.some((file) => file.state === "unknown") ? "unknown" : "unchanged";
    results.push({ id: topic.id, fingerprint: topicFingerprint(topic), checkedAt: now, state, files });
  }
  return results;
}

export function topicDiagramRequirement(topic: ProjectTopic): string {
  return [
    `Explain one topic: ${topic.title}.`,
    topic.kind === "flow" ? "Show only the normal path, with at most 8 steps. Summarize exception handling in descriptions; do not add retry, timeout or cancellation branches." : "Show this responsibility boundary, its entry points and immediate collaborators, with at most 10 nodes. Keep one abstraction level.",
    "Use current source excerpts to establish the behavior. The saved topic below is an unverified historical hypothesis, not evidence. Omit unsupported claims and state limitations in descriptions.",
    `Saved topic: ${JSON.stringify({ id: topic.id, description: topic.description, entryPoints: topic.entryPoints, steps: topic.steps, sections: topic.sections })}`,
    "For nodes that describe an existing step or boundary, include that exact saved step/boundary id in semanticIds. Do not create a new id for the same concept. These IDs link the diagram back to the explanation; omit a link if the current evidence contradicts the saved claim.",
    "Use short labels. This view must answer a single question and remain readable without fitting a repository-wide graph onto one screen."
  ].join("\n");
}
