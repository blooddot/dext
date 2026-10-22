import type { ProjectDiagram, ProjectDiagramEvidence, ProjectDiagramNode } from "../../contracts/projectDiagram.js";
import type { ProjectEvidence } from "../../contracts/projectKnowledge.js";
import type { ProjectTopic } from "../../knowledge/projectTopics.js";
import type { StructureMember, StructureModule, StructureSummary } from "../indexing/projectStructure.js";
import { buildStructureGraphFromSummary, type StructureGraphNode } from "../indexing/projectStructureGraph.js";

export const STRUCTURE_MAP_MAX_NODES = 180;
export const STRUCTURE_MAP_MAX_FILES_PER_MODULE = 6;
export const STRUCTURE_MAP_MAX_SYMBOLS_PER_ENTRY_FILE = 2;

const evidenceOf = (path: string, contentHash?: string, line?: number, symbol?: string): ProjectDiagramEvidence =>
  ({ path, ...(line !== undefined ? { line } : {}), ...(symbol ? { symbol } : {}), ...(contentHash ? { contentHash } : {}) });

function topicEvidence(entries: readonly ProjectDiagramEvidence[], limit = 40): ProjectEvidence[] {
  return [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()].slice(0, limit);
}

function rankedFiles(module: StructureModule, graph: ReadonlyMap<string, StructureGraphNode>): StructureMember[] {
  const entryPoints = new Set(module.entryPoints);
  return [...module.members].sort((left, right) => {
    const leftEntry = Number(entryPoints.has(left.path));
    const rightEntry = Number(entryPoints.has(right.path));
    const leftRank = graph.get(left.path)?.rank ?? 0;
    const rightRank = graph.get(right.path)?.rank ?? 0;
    const leftConsumers = graph.get(left.path)?.consumers ?? 0;
    const rightConsumers = graph.get(right.path)?.consumers ?? 0;
    return rightEntry - leftEntry || rightConsumers - leftConsumers || rightRank - leftRank || left.path.localeCompare(right.path);
  });
}

/**
 * Physical hierarchy only: project -> configured module -> representative file -> representative
 * declaration. Every node except the synthetic root cites an indexed file and its content hash.
 */
export function buildStructureMap(summary: StructureSummary, updatedAt: number): { diagram: ProjectDiagram; topic: ProjectTopic } {
  const graph = buildStructureGraphFromSummary(summary);
  const graphNodes = new Map(graph.nodes.map((node) => [node.path, node]));
  const nodes: ProjectDiagramNode[] = [{
    id: "structure:root",
    label: "Project",
    role: "system",
    description: `${summary.modules.length} modules · ${summary.parsed} indexed files`,
    semanticIds: ["structure:root"],
    evidence: []
  }];
  const modules = [...summary.modules].sort((left, right) => left.path.localeCompare(right.path));
  const push = (node: ProjectDiagramNode): boolean => {
    if (nodes.length >= STRUCTURE_MAP_MAX_NODES - 1) return false;
    nodes.push(node);
    return true;
  };
  let moduleIndex = 0;
  for (; moduleIndex < modules.length; moduleIndex += 1) {
    if (nodes.length >= STRUCTURE_MAP_MAX_NODES - 1) break;
    const module = modules[moduleIndex]!;
    const moduleId = `structure:module:${module.path}`;
    if (!push({
      id: moduleId,
      label: module.path,
      role: "module",
      description: `${module.files} file${module.files === 1 ? "" : "s"} · ${module.languages.join(", ")}`,
      parentId: "structure:root",
      semanticIds: [module.id],
      evidence: module.evidence.slice(0, 3).map((entry) => evidenceOf(entry.path, entry.contentHash))
    })) break;
    const files = rankedFiles(module, graphNodes).slice(0, STRUCTURE_MAP_MAX_FILES_PER_MODULE);
    for (const [fileIndex, file] of files.entries()) {
      const fileId = `structure:file:${file.path}`;
      if (!push({
        id: fileId,
        label: file.path.split("/").at(-1) ?? file.path,
        role: "component",
        description: file.path,
        parentId: moduleId,
        semanticIds: [file.path],
        evidence: [evidenceOf(file.path, file.hash)]
      })) break;
      const showSymbols = module.entryPoints.includes(file.path) || fileIndex < 2;
      if (!showSymbols) continue;
      const symbols = file.symbols.filter((symbol) => !symbol.ownerId).slice(0, STRUCTURE_MAP_MAX_SYMBOLS_PER_ENTRY_FILE);
      for (const symbol of symbols) {
        if (!push({
          id: `structure:symbol:${symbol.id}`,
          label: symbol.name,
          role: "unknown",
          description: symbol.kind.replaceAll("_", " "),
          parentId: fileId,
          semanticIds: [symbol.id],
          evidence: [evidenceOf(file.path, file.hash, symbol.line, symbol.name)]
        })) break;
      }
    }
  }
  if (moduleIndex < modules.length) {
    const remaining = modules.length - moduleIndex;
    if (nodes.length < STRUCTURE_MAP_MAX_NODES) nodes.push({
      id: "structure:more-modules",
      label: `${remaining} more modules`,
      role: "unknown",
      description: "Remaining modules are covered by the structure index but omitted from this map's node budget.",
      parentId: "structure:root",
      semanticIds: ["structure:more-modules"],
      evidence: []
    });
  }
  const evidence = topicEvidence(nodes.flatMap((node) => node.evidence));
  const qualityWarnings = [
    ...(modules.length > moduleIndex ? [`Structure map shows ${moduleIndex} of ${modules.length} modules; the rest are summarized as one node.`] : []),
    ...summary.issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.reason}`)
  ];
  const diagram: ProjectDiagram = {
    schemaVersion: 1,
    id: "structure:map",
    title: "Structure map",
    kind: "tree",
    version: 1,
    updatedAt,
    nodes,
    relations: [],
    metadata: { derived: true, structureMap: true, structureHash: summary.hash },
    ...(qualityWarnings.length ? { confidence: 0.8 } : {})
  };
  const topic: ProjectTopic = {
    id: "structure:map",
    title: "Structure map",
    kind: "structure",
    analysisState: "ready",
    description: "Physical module, file and declaration hierarchy from the local structure index.",
    responsibilities: [`${summary.modules.length} modules`, `${summary.parsed} indexed files`],
    entryPoints: [...new Set(modules.flatMap((module) => module.entryPoints))].slice(0, 12),
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
