import { projectModelNodeSchema, projectModelRelationSchema, type ProjectModel, type ProjectModelNode } from "../../contracts/projectModel.js";
import { parseProjectModel } from "../../knowledge/projectModel.js";
import { ProjectModelStore } from "./projectModelStore.js";
import { ProjectStore, projectContentHash, type ProjectFileHost, type ProjectLegacySnapshot } from "./projectStore.js";

/** Deterministic legacy import; source identities remain stable unless they collide. */
export function migrateProjectModel(snapshot: ProjectLegacySnapshot): ProjectModel {
  const nodes: ProjectModelNode[] = []; const relations: ProjectModel["relations"] = []; const aliases: Record<string, string> = {};
  const used = new Set<string>();
  const sourceHash = projectContentHash(JSON.stringify(snapshot.files.map(file => [file.path, file.hash])));
  const allocate = (scope: string, id: string): string => {
    const candidate = used.has(id) ? `${id}~${projectContentHash(`${scope}:${id}`).slice(0, 12)}` : id;
    if (used.has(candidate)) throw new Error(`Unresolvable legacy ID collision: ${id}`);
    used.add(candidate); aliases[`${scope}:${id}`] = candidate; return candidate;
  };
  const add = (scope: string, id: string, kind: ProjectModelNode["kind"], value: Record<string, unknown>, text: string): ProjectModelNode => {
    const properties = { ...value };
    for (const key of ["id", "description", "summary", "purpose", "definition", "statement", "decision", "detail", "relatedIds", "contextIds", "dependsOn", "relatedContextIds", "nextStepIds", "steps", "parentId"]) delete properties[key];
    const node = projectModelNodeSchema.parse({ id: allocate(scope, id), kind, title: value.displayName ?? value.title ?? value.canonicalName ?? value.name ?? value.label ?? id,
      canonicalName: value.canonicalName ?? value.name ?? id, body: { kind: "inline", text }, paths: value.paths ?? value.sourceFiles ?? [],
      origin: value.origin ?? (value.source === "user" ? "declared" : "inferred"), review: value.review ?? value.confirmation ?? "draft", freshness: value.freshness ?? value.validity ?? "current", evidence: value.evidence ?? [], properties: { ...properties, legacyScope: scope } });
    nodes.push(node); return node;
  };
  const link = (from: string, to: string, kind: ProjectModel["relations"][number]["kind"], owner: ProjectModelNode): void => {
    if (!used.has(to)) throw new Error(`Legacy relation target is missing: ${to}`);
    relations.push(projectModelRelationSchema.parse({ id: `${kind}:${encodeURIComponent(from)}:${encodeURIComponent(to)}`, from, to, kind, origin: owner.origin, review: owner.review, freshness: owner.freshness }));
  };
  for (const object of snapshot.objects) add("objects", object.id, object.kind, object, object.description);
  const intent = snapshot.intent;
  if (intent) {
    add("brief", "project", "project", intent.brief, intent.brief.summary);
    for (const [collection, kind] of [["capabilities", "capability"], ["contexts", "context"], ["flows", "flow"], ["terms", "term"], ["constraints", "constraint"], ["decisions", "decision"]] as const) {
      for (const item of intent[collection]) {
        const text = "description" in item ? item.description : "purpose" in item ? item.purpose : "definition" in item ? item.definition : "statement" in item ? item.statement : item.decision;
        add("intent", item.id, kind, item, text);
        if ("steps" in item) for (const step of item.steps) add(`flow:${item.id}`, step.id, "step", step, step.description ?? "");
      }
    }
    if (intent.c4) for (const element of intent.c4.elements) add("c4", element.id, element.kind, element, element.description);
    const root = nodes.find(node => node.kind === "project")!;
    if (intent.c4) root.properties.c4SystemId = aliases[`c4:${intent.c4.systemId}`];
    if (intent.structure) root.properties.structure = intent.structure;
    if (intent.qualityIssues) root.properties.qualityIssues = intent.qualityIssues.map(issue => ({ ...issue, contextIds: issue.contextIds.map(id => aliases[`intent:${id}`] ?? id) }));
  }
  for (const object of snapshot.objects) for (const id of object.relatedIds) link(aliases[`objects:${object.id}`]!, aliases[`objects:${id}`]!, "related_to", nodes.find(node => node.id === aliases[`objects:${object.id}`])!);
  if (intent) {
    const native = (id: string) => nodes.find(node => node.id === aliases[`intent:${id}`])!;
    for (const item of intent.contexts) {
      for (const id of item.dependsOn) link(native(item.id).id, native(id).id, "depends_on", native(item.id));
      for (const id of item.relatedContextIds) link(native(item.id).id, native(id).id, "related_to", native(item.id));
    }
    for (const item of [...intent.capabilities, ...intent.terms]) for (const id of item.contextIds) link(native(item.id).id, native(id).id, "maps_to", native(item.id));
    for (const flow of intent.flows) for (const step of flow.steps) {
      const stepId = aliases[`flow:${flow.id}:${step.id}`]!;
      link(native(flow.id).id, stepId, "contains", native(flow.id));
      if (step.contextId) link(stepId, native(step.contextId).id, "maps_to", native(flow.id));
      for (const next of step.nextStepIds) link(stepId, aliases[`flow:${flow.id}:${next}`]!, "flows_to", native(flow.id));
    }
    if (intent.c4) {
      for (const element of intent.c4.elements) {
        const owner = nodes.find(node => node.id === aliases[`c4:${element.id}`])!;
        if (element.parentId) link(aliases[`c4:${element.parentId}`]!, owner.id, "contains", owner);
        for (const id of element.contextIds) link(owner.id, native(id).id, "maps_to", owner);
      }
      for (const relation of intent.c4.relationships) {
        relations.push(projectModelRelationSchema.parse({ id: `c4:${relation.id}`, description: relation.description, evidence: relation.evidence, from: aliases[`c4:${relation.from}`], to: aliases[`c4:${relation.to}`], kind: "communicates", origin: "declared", review: "draft", freshness: "needs_verification" }));
      }
    }
  }
  if (snapshot.architecture) {
    const diagram = snapshot.diagram;
    if (diagram) for (const endpoint of diagram.nodes) add(`diagram:${diagram.id}`, endpoint.id, "architecture", { ...endpoint, canonicalName: endpoint.label, legacyDiagramId: diagram.id, legacyNodeId: endpoint.id }, endpoint.description ?? endpoint.label);
    for (const decision of snapshot.architecture.decisions) add("architecture", decision.id, "decision", decision, decision.detail);
    for (const rule of snapshot.architecture.rules) {
      const owner = add("architecture", rule.id, "constraint", { ...rule, from: undefined, to: undefined, canonicalName: rule.id, diagramId: snapshot.architecture.diagramId ?? diagram?.id, wildcardFrom: rule.from === "*" }, rule.reason ?? `${rule.type}: ${rule.from} ${rule.to ?? ""}`);
      for (const [role, endpoint] of [["from", rule.from], ["to", rule.to]] as const) if (endpoint && endpoint !== "*") {
        const target = aliases[`diagram:${diagram?.id}:${endpoint}`];
        if (!target) throw new Error(`Architecture endpoint is missing: ${endpoint}`);
        relations.push(projectModelRelationSchema.parse({ id: `${owner.id}:${role}`, from: owner.id, to: target, kind: "constrains", description: role, origin: owner.origin, review: owner.review, freshness: owner.freshness }));
      }
    }
  }
  return parseProjectModel({ schemaVersion: 1, revision: 0, nodes, relations, updatedAt: 0, migration: { sourceHash, aliases, backup: `.dext/project/migrations/${sourceHash}.json` } });
}

export async function commitProjectMigration(host: ProjectFileHost, snapshot: ProjectLegacySnapshot): Promise<ProjectModel> {
  const store = new ProjectModelStore(host); const existing = await store.read();
  if (existing) return existing;
  const model = migrateProjectModel(snapshot);
  // Preserve exact source bytes before the format switch. Retrying writes the same backup.
  await host.writeFile(model.migration!.backup, JSON.stringify({ sourceHash: model.migration!.sourceHash, files: snapshot.files }, null, 2));
  for (const file of snapshot.files) {
    const current = await (host.readFileStrict ? host.readFileStrict(file.path) : host.readFile(file.path));
    if (current === undefined || projectContentHash(current) !== file.hash) throw new Error("Legacy Project changed during migration.");
  }
  const current = await new ProjectStore(host).readLegacySnapshot();
  if (JSON.stringify(current.files.map(file => [file.path, file.hash])) !== JSON.stringify(snapshot.files.map(file => [file.path, file.hash]))) throw new Error("Legacy Project file set changed during migration.");
  return store.update(model, null);
}
