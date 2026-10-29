import { projectModelSchema, type ProjectModel } from "../contracts/projectModel.js";
import { projectIntentSchema, type ProjectIntent } from "../contracts/projectIntent.js";
import { knowledgeText } from "./projectKnowledge.js";

export function validateProjectModel(model: ProjectModel): string[] {
  const errors: string[] = []; const nodes = new Set<string>(); const relations = new Set<string>(); const documents = new Map<string, string>();
  for (const node of model.nodes) {
    if (nodes.has(node.id)) errors.push(`Duplicate node '${node.id}'.`);
    nodes.add(node.id);
    if (/\.plan\.md$/i.test(node.id)) errors.push(`A Plan cannot be a normative node: ${node.id}`);
    if (node.body.kind === "document") {
      const path = node.body.path.toLowerCase();
      if (documents.has(path)) errors.push(`Document '${node.body.path}' has multiple owners.`);
      documents.set(path, node.id);
    }
  }
  const parents = new Map<string, string[]>();
  for (const relation of model.relations) {
    if (relations.has(relation.id)) errors.push(`Duplicate relation '${relation.id}'.`);
    relations.add(relation.id);
    if (!nodes.has(relation.from) || !nodes.has(relation.to)) errors.push(`Dangling relation '${relation.id}'.`);
    if (relation.kind === "contains") parents.set(relation.to, [...parents.get(relation.to) ?? [], relation.from]);
  }
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) { errors.push(`Containment cycle at '${id}'.`); return; }
    if (visited.has(id)) return;
    active.add(id); for (const parent of parents.get(id) ?? []) visit(parent);
    active.delete(id); visited.add(id);
  };
  for (const id of nodes) visit(id);
  return errors;
}

export function parseProjectModel(value: unknown): ProjectModel {
  const model = projectModelSchema.parse(value);
  const errors = validateProjectModel(model);
  if (errors.length) throw new Error(errors.join(" "));
  return model;
}

/** Transitional read view for existing diagrams; the native model remains the sole writer. */
export function projectModelIntent(model: ProjectModel, documents: ReadonlyMap<string, string> = new Map()): ProjectIntent {
  const outgoing = (id: string, kind: string) => model.relations.filter(edge => edge.from === id && edge.kind === kind).map(edge => edge.to);
  const incoming = (id: string, kind: string) => model.relations.filter(edge => edge.to === id && edge.kind === kind).map(edge => edge.from);
  const domain = (node: ProjectModel["nodes"][number]) => {
    const allowed: Record<string, string[]> = { context: ["structureHash", "detail", "responsibilities", "moduleIds", "entryPoints", "previousContextIds", "uncertainties"], capability: ["outcomes", "moduleIds"], term: ["aliases", "forbiddenNames"], flow: ["trigger", "outcomes"] };
    const properties = Object.fromEntries(Object.entries(node.properties).filter(([key]) => allowed[node.kind]?.includes(key)));
    return { ...properties, id: node.id, canonicalName: node.canonicalName, displayName: node.title, origin: node.origin, review: node.review, freshness: node.freshness, confidence: node.confidence, evidence: node.evidence };
  };
  const text = (node: ProjectModel["nodes"][number]) => knowledgeText(node, documents) ?? "Document unavailable; review required.";
  const root = model.nodes.find(node => node.kind === "project");
  const contexts = model.nodes.filter(node => node.kind === "context");
  const c4 = model.nodes.filter(node => ["person", "system", "container"].includes(node.kind));
  return projectIntentSchema.parse({
    schemaVersion: 1, updatedAt: model.updatedAt,
    ...(root?.properties.structure ? { structure: root.properties.structure } : {}),
    ...(root?.properties.qualityIssues ? { qualityIssues: root.properties.qualityIssues } : {}),
    ...(c4.length ? { c4: {
      systemId: root?.properties.c4SystemId ?? c4.find(node => node.kind === "system" && !node.properties.external)?.id,
      elements: c4.map(node => ({ id: node.id, name: node.title, description: text(node), kind: node.kind, external: node.properties.external ?? false,
        ...(node.properties.technology ? { technology: node.properties.technology } : {}),
        ...(node.kind === "container" ? { parentId: incoming(node.id, "contains")[0] } : {}), contextIds: outgoing(node.id, "maps_to"), evidence: node.evidence })),
      relationships: model.relations.filter(edge => edge.kind === "communicates").map(edge => ({ id: edge.id, from: edge.from, to: edge.to, description: edge.description, evidence: edge.evidence }))
    } } : {}),
    brief: { name: root?.title ?? "Project", summary: root ? text(root) : "", goals: root?.properties.goals ?? [], runtime: root?.properties.runtime ?? [], audiences: root?.properties.audiences ?? [], origin: root?.origin ?? "inferred", review: root?.review ?? "draft", freshness: root?.freshness ?? "current" },
    contexts: contexts.map(node => ({ ...domain(node), purpose: text(node), sourceFiles: node.paths, dependsOn: outgoing(node.id, "depends_on"), relatedContextIds: outgoing(node.id, "related_to") })),
    capabilities: model.nodes.filter(node => node.kind === "capability").map(node => ({ ...domain(node), description: text(node), contextIds: outgoing(node.id, "maps_to") })),
    terms: model.nodes.filter(node => node.kind === "term").map(node => ({ ...domain(node), definition: text(node), contextIds: outgoing(node.id, "maps_to") })),
    constraints: model.nodes.filter(node => node.kind === "constraint" && node.properties.legacyScope !== "architecture").map(node => ({ id: node.id, statement: text(node), rationale: node.properties.rationale ?? "", scope: node.properties.scope ?? [], origin: node.origin, review: node.review, freshness: node.freshness, evidence: node.evidence })),
    decisions: model.nodes.filter(node => node.kind === "decision").map(node => ({ id: node.id, title: node.title, decision: text(node), alternatives: node.properties.alternatives ?? [], consequences: node.properties.consequences ?? [], origin: node.origin, review: node.review, freshness: node.freshness, evidence: node.evidence })),
    flows: model.nodes.filter(node => node.kind === "flow").map(node => ({ ...domain(node), description: text(node), steps: model.nodes.filter(step => step.kind === "step" && incoming(step.id, "contains").includes(node.id)).map(step => ({ id: step.id, label: step.title, description: text(step), ...(outgoing(step.id, "maps_to")[0] ? { contextId: outgoing(step.id, "maps_to")[0] } : {}), nextStepIds: outgoing(step.id, "flows_to"), evidence: step.evidence })) }))
  });
}
