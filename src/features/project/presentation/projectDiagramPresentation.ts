import type { ProjectDiagram } from "../contracts/projectDiagram.js";

/** Only play recorded message order or an unambiguous connected path, never arbitrary array order. */
export function projectPlaybackSteps(diagram: ProjectDiagram): { id: string; kind: "node" | "relation" }[] {
  if (diagram.kind === "sequence") return [...(diagram.semantics?.messages ?? [])].sort((a, b) => a.order - b.order).map((message) => ({ id: message.relationId, kind: "relation" }));
  if (diagram.kind !== "workflow") return [];
  if (diagram.semantics?.mainPath?.length) return diagram.semantics.mainPath.map((id) => ({ id, kind: "node" }));
  const starts = diagram.nodes.filter((node) => !diagram.relations.some((relation) => relation.to === node.id));
  if (starts.length !== 1) return [];
  const path: string[] = [];
  let current: string | undefined = starts[0]!.id;
  while (current && !path.includes(current)) {
    path.push(current);
    const next = diagram.relations.filter((relation) => relation.from === current);
    if (next.length > 1) return [];
    current = next[0]?.to;
  }
  return current || path.length !== diagram.nodes.length ? [] : path.map((id) => ({ id, kind: "node" }));
}
