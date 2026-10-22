import type { ProjectDiagram, ProjectDiagramClassKind, ProjectDiagramEvidence, ProjectDiagramMember, ProjectDiagramNode, ProjectDiagramRelation } from "../../contracts/projectDiagram.js";
import type { ProjectEvidence } from "../../contracts/projectKnowledge.js";
import type { ProjectTopic } from "../../knowledge/projectTopics.js";
import type { StructureMember, StructureSummary, StructureSymbol } from "../indexing/projectStructure.js";
import { buildStructureGraphFromSummary } from "../indexing/projectStructureGraph.js";

export const CLASS_MAP_MAX_TYPES = 60;
export const CLASS_MAP_MAX_MEMBERS_PER_TYPE = 12;
export const CLASS_MAP_MAX_MEMBERS = 240;

const CLASS_KINDS: Record<string, ProjectDiagramClassKind> = {
  class_declaration: "class",
  abstract_class_declaration: "abstract",
  interface_declaration: "interface",
  enum_declaration: "enum",
  class_definition: "class",
  struct_item: "record",
  enum_item: "enum",
  trait_item: "interface"
};

interface TypeEntry {
  symbol: StructureSymbol;
  member: StructureMember;
}

const evidenceOf = (entry: TypeEntry): ProjectDiagramEvidence => ({
  path: entry.member.path,
  line: entry.symbol.line,
  symbol: entry.symbol.name,
  contentHash: entry.member.hash
});

function topicEvidence(entries: readonly ProjectDiagramEvidence[], limit = 40): ProjectEvidence[] {
  return [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()].slice(0, limit);
}

function diagramMember(symbol: StructureSymbol): ProjectDiagramMember {
  return {
    name: symbol.name,
    kind: symbol.memberKind === "method" ? "method" : "attribute",
    ...(symbol.typeText ? { type: symbol.typeText } : {}),
    ...(symbol.parameters ? { parameters: symbol.parameters } : {}),
    ...(symbol.returns ? { returns: symbol.returns } : {}),
    ...(symbol.visibility ? { visibility: symbol.visibility } : {}),
    ...(symbol.static ? { static: true } : {}),
    ...(symbol.abstract ? { abstract: true } : {})
  };
}

/**
 * Explicit type declarations and explicit heritage only. A relationship is emitted when the target
 * type name is unique among the selected types; ambiguous or unresolved names stay a warning.
 */
export function buildClassMap(summary: StructureSummary, updatedAt: number): { diagram: ProjectDiagram; topic: ProjectTopic } {
  const graph = buildStructureGraphFromSummary(summary);
  const graphNodes = new Map(graph.nodes.map((node) => [node.path, node]));
  const entries: TypeEntry[] = [];
  const seenTypes = new Set<string>();
  for (const module of summary.modules) for (const member of module.members) for (const symbol of member.symbols) {
    if (!CLASS_KINDS[symbol.kind] || seenTypes.has(symbol.id)) continue;
    seenTypes.add(symbol.id);
    entries.push({ symbol, member });
  }
  const members = summary.modules.flatMap((module) => module.members.flatMap((member) => member.symbols))
    .filter((symbol) => symbol.memberKind !== undefined);
  const byOwnerId = new Map<string, StructureSymbol[]>();
  const byOwnerName = new Map<string, StructureSymbol[]>();
  for (const member of members) {
    if (member.ownerId) byOwnerId.set(member.ownerId, [...(byOwnerId.get(member.ownerId) ?? []), member]);
    if (member.ownerName) byOwnerName.set(member.ownerName, [...(byOwnerName.get(member.ownerName) ?? []), member]);
  }
  const allByName = new Map<string, TypeEntry[]>();
  for (const entry of entries) allByName.set(entry.symbol.name, [...(allByName.get(entry.symbol.name) ?? []), entry]);
  const selected = [...entries].sort((left, right) => {
    const leftMembers = (byOwnerId.get(left.symbol.id)?.length ?? 0) + (allByName.get(left.symbol.name)?.length === 1 ? byOwnerName.get(left.symbol.name)?.length ?? 0 : 0);
    const rightMembers = (byOwnerId.get(right.symbol.id)?.length ?? 0) + (allByName.get(right.symbol.name)?.length === 1 ? byOwnerName.get(right.symbol.name)?.length ?? 0 : 0);
    const leftHeritage = Number((left.symbol.extends?.length ?? 0) + (left.symbol.implements?.length ?? 0) > 0);
    const rightHeritage = Number((right.symbol.extends?.length ?? 0) + (right.symbol.implements?.length ?? 0) > 0);
    return rightMembers - leftMembers || rightHeritage - leftHeritage
      || (graphNodes.get(right.member.path)?.rank ?? 0) - (graphNodes.get(left.member.path)?.rank ?? 0)
      || left.member.path.localeCompare(right.member.path) || left.symbol.line - right.symbol.line;
  }).slice(0, CLASS_MAP_MAX_TYPES);
  const selectedByName = new Map<string, TypeEntry[]>();
  for (const entry of selected) selectedByName.set(entry.symbol.name, [...(selectedByName.get(entry.symbol.name) ?? []), entry]);
  const membersFor = (entry: TypeEntry): StructureSymbol[] => {
    const direct = byOwnerId.get(entry.symbol.id) ?? [];
    const uniqueName = allByName.get(entry.symbol.name)?.length === 1;
    const byName = uniqueName ? byOwnerName.get(entry.symbol.name) ?? [] : [];
    return [...new Map([...direct, ...byName].map((member) => [member.id, member])).values()]
      .sort((left, right) => left.line - right.line || left.name.localeCompare(right.name))
      .slice(0, CLASS_MAP_MAX_MEMBERS_PER_TYPE);
  };
  let unresolved = 0;
  let ambiguous = 0;
  let skipped = 0;
  const relations: ProjectDiagramRelation[] = [];
  for (const entry of selected) {
    const source = entry.symbol;
    const sourceEvidence = evidenceOf(entry);
    const targets: Array<{ name: string; kind: "inheritance" | "realization" }> = [
      ...(source.extends ?? []).map((name) => ({ name, kind: "inheritance" as const })),
      ...(source.implements ?? []).map((name) => ({ name, kind: "realization" as const }))
    ];
    for (const target of targets) {
      const candidates = selectedByName.get(target.name) ?? [];
      if (!candidates.length) { unresolved += 1; continue; }
      if (candidates.length > 1) { ambiguous += 1; continue; }
      const resolved = candidates[0]!;
      if (resolved.symbol.id === source.id) { skipped += 1; continue; }
      // The class renderer forbids inheritance into an interface and realization into a class.
      if (target.kind === "inheritance" && resolved.symbol.kind === "interface_declaration") { skipped += 1; continue; }
      if (target.kind === "realization" && resolved.symbol.kind !== "interface_declaration") { skipped += 1; continue; }
      const id = `class:${source.id}->${resolved.symbol.id}:${target.kind}`;
      if (relations.some((relation) => relation.id === id)) continue;
      relations.push({
        id,
        from: source.id,
        to: resolved.symbol.id,
        kind: target.kind,
        evidence: [sourceEvidence]
      });
    }
  }
  const totalMembers = selected.reduce((sum, entry) => sum + membersFor(entry).length, 0);
  let remainingMembers = CLASS_MAP_MAX_MEMBERS;
  const nodes: ProjectDiagramNode[] = selected.map((entry) => {
    const declared = membersFor(entry);
    const kept = declared.slice(0, remainingMembers);
    remainingMembers -= kept.length;
    return {
      id: entry.symbol.id,
      label: entry.symbol.name,
      role: "module",
      classKind: CLASS_KINDS[entry.symbol.kind]!,
      description: entry.member.path,
      semanticIds: [entry.symbol.id],
      evidence: [evidenceOf(entry)],
      ...(kept.length ? { members: kept.map(diagramMember) } : {})
    };
  });
  const evidence = topicEvidence(nodes.flatMap((node) => node.evidence));
  const languages = new Set(selected.map((entry) => entry.member.language));
  const qualityWarnings = [
    ...(entries.length > selected.length ? [`Type map shows ${selected.length} of ${entries.length} explicit types.`] : []),
    ...(unresolved ? [`${unresolved} explicit heritage name${unresolved === 1 ? "" : "s"} did not resolve to a selected type.`] : []),
    ...(ambiguous ? [`${ambiguous} explicit heritage name${ambiguous === 1 ? "" : "s"} matched more than one selected type and ${ambiguous === 1 ? "was" : "were"} skipped.`] : []),
    ...(skipped ? [`${skipped} heritage relation${skipped === 1 ? "" : "s"} could not be represented without violating the class notation.`] : []),
    ...(languages.has("python") ? ["Python instance fields (self.x) are not extracted; only class-level annotations are shown."] : []),
    ...(languages.has("rust") ? ["Rust `impl Trait for Type` relationships are not extracted."] : []),
    ...(totalMembers > CLASS_MAP_MAX_MEMBERS ? [`Member display is bounded to ${CLASS_MAP_MAX_MEMBERS} entries.`] : []),
    ...summary.issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.reason}`)
  ];
  const diagram: ProjectDiagram = {
    schemaVersion: 1,
    id: "structure:types",
    title: "Type map",
    kind: "class",
    version: 1,
    updatedAt,
    nodes,
    relations,
    metadata: { derived: true, classMap: true, structureHash: summary.hash },
    ...(qualityWarnings.length ? { confidence: 0.8 } : {})
  };
  const topic: ProjectTopic = {
    id: "structure:types",
    title: "Type map",
    kind: "types",
    analysisState: "ready",
    description: "Explicit types, their declared members and only unambiguous inheritance/implementation.",
    responsibilities: [`${selected.length} types`, `${totalMembers} members`, `${relations.length} explicit relationships`],
    entryPoints: [...new Set(selected.map((entry) => entry.member.path))].slice(0, 12),
    steps: [],
    constraints: [],
    evidence,
    diagrams: [],
    review: "derived",
    basis: summary.hash,
    ...(qualityWarnings.length ? { qualityWarnings } : {}),
    diagram
  };
  return { diagram, topic };
}
