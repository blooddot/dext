import type { ProjectDiagramEvidence } from "../contracts/projectDiagram.js";
import type { ProjectIntent } from "../contracts/projectIntent.js";
import type { ProjectTopic } from "../knowledge/projectTopics.js";

/** Collapse process boundaries, not interactions. Preserve direction and all supporting evidence. */
export function systemContextRelationships(model: NonNullable<ProjectIntent["c4"]>): typeof model.relationships {
  const parents = new Map(model.elements.filter(element => element.kind === "container").map(element => [element.id, element.parentId!]));
  const groups = new Map<string, typeof model.relationships>();
  for (const relation of model.relationships) {
    const from = parents.get(relation.from) ?? relation.from, to = parents.get(relation.to) ?? relation.to;
    if (from === to) continue;
    const key = JSON.stringify([from, to]);
    groups.set(key, [...(groups.get(key) ?? []), { ...relation, from, to }]);
  }
  return [...groups.values()].map(group => ({ ...group[0]!,
    description: [...new Set(group.map(item => item.description))].join("; "),
    technology: [...new Set(group.flatMap(item => item.technology ? [item.technology] : []))].join("; "),
    evidence: [...new Map(group.flatMap(item => item.evidence).map(item => [JSON.stringify(item), item])).values()]
  }));
}

/** Separate C1/C2 views of explicitly recorded boundaries; old contexts are never reclassified. */
export function buildC4Topics(intent: ProjectIntent): ProjectTopic[] {
  const model = intent.c4;
  if (!model) return [];
  const system = model.elements.find((element) => element.id === model.systemId);
  if (!system) return [];
  const evidence = (entries: typeof system.evidence): ProjectDiagramEvidence[] => entries.map((entry) => ({ path: entry.path,
    ...(entry.line !== undefined ? { line: entry.line } : {}), ...(entry.symbol ? { symbol: entry.symbol } : {}),
    ...(entry.note ? { note: entry.note } : {}), ...(entry.contentHash ? { contentHash: entry.contentHash } : {}) }));
  return (["system_context", "containers"] as const).map((kind): ProjectTopic => {
    const id = `c4:${kind}:${model.systemId}`;
    const units = model.elements.filter((element) => element.kind === "container" && element.parentId === model.systemId);
    const visible = kind === "system_context" ? model.elements.filter((element) => element.kind !== "container")
      : [...units, ...model.elements.filter((element) => element.kind !== "container" && element.id !== model.systemId
        && model.relationships.some((relation) => units.some((unit) => (relation.from === unit.id && relation.to === element.id) || (relation.to === unit.id && relation.from === element.id))))];
    const ids = new Set(visible.map((element) => element.id));
    const relationships = (kind === "system_context" ? systemContextRelationships(model) : model.relationships)
      .filter((relation) => ids.has(relation.from) && ids.has(relation.to));
    const title = kind === "system_context" ? "Project landscape" : "Runtime units";
    const relatedIds = new Set(visible.flatMap((element) => element.contextIds));
    return {
      id, kind, title, description: kind === "system_context" ? system.description || intent.brief.summary : `Applications and data stores inside ${system.name}.`,
      review: "draft", responsibilities: [], entryPoints: [], steps: [], constraints: [], diagrams: [],
      evidence: [...visible.flatMap((element) => element.evidence), ...relationships.flatMap((relation) => relation.evidence)],
      sections: visible.map((element) => ({ id: element.id, title: element.name, description: element.description, evidence: element.evidence, relatedTopicIds: element.contextIds })),
      relatedTopics: [
        { id: `c4:${kind === "system_context" ? "containers" : "system_context"}:${model.systemId}`, title: kind === "system_context" ? "Runtime units" : "Project landscape" },
        ...intent.contexts.filter((context) => relatedIds.has(context.id)).map((context) => ({ id: context.id, title: context.displayName ?? context.canonicalName }))
      ],
      diagram: { schemaVersion: 1, id: `topic-view:${id}`, title, kind: "architecture", version: 0, updatedAt: intent.updatedAt,
        metadata: { derived: true, topicId: id, c4Level: kind === "system_context" ? 1 : 2 },
        nodes: visible.map((element) => ({ id: element.id, label: `${element.name}\n[${element.kind}${element.external ? " · external" : ""}]`, role: element.kind === "person" ? "actor" : element.kind,
          description: [element.description, element.technology].filter(Boolean).join(" · "), evidence: evidence(element.evidence),
          semanticIds: [element.id, ...element.contextIds, ...(element.id === model.systemId ? [`c4:containers:${model.systemId}`] : [])] })),
        relations: relationships.map((relation) => ({ id: relation.id, from: relation.from, to: relation.to, kind: "unknown", label: [relation.description, relation.technology].filter(Boolean).join(" · "), evidence: evidence(relation.evidence) })),
        ...(kind === "containers" && units.length ? { semantics: { boundaries: [{ id: model.systemId, label: system.name, nodeIds: units.map((unit) => unit.id), evidence: evidence(system.evidence) }] } } : {})
      }
    };
  });
}
