import type { ProjectDiagram, ProjectDiagramRelation } from "./projectDiagram.js";

export interface ProjectMermaidView {
  source: string;
  nodes: { key: string; id: string }[];
  relations: { key: string; id: string }[];
  kind: "flowchart" | "sequence" | "state";
  note?: string;
}

/** All IDs are local tokens and all labels are quoted/encoded, never executable Mermaid. */
const label = (value: string): string => Array.from(value.replace(/\s+/g, " ").trim()).map((character) =>
  /[\p{L}\p{N} .,_()/-]/u.test(character) ? character : `#${character.codePointAt(0)};`).join("");

export function projectDiagramToMermaid(diagram: ProjectDiagram): ProjectMermaidView {
  const nodes = diagram.nodes.map((node, index) => ({ key: `N${index}`, id: node.id }));
  const ids = new Map(nodes.map((node) => [node.id, node.key]));
  const usable = diagram.relations.filter((relation) => ids.has(relation.from) && ids.has(relation.to));
  const relations = usable.map((relation, index) => ({ key: `E${index}`, id: relation.id }));
  const text = (relation: ProjectDiagramRelation) => label([relation.label || relation.kind.replaceAll("_", " "), relation.condition ? `[${relation.condition}]` : "", relation.exception ? "(exception)" : ""].filter(Boolean).join(" · "));
  if (diagram.kind === "sequence" && diagram.semantics?.messages?.length) {
    const ordered = [...diagram.semantics.messages].sort((a, b) => a.order - b.order);
    const participants = [...(diagram.semantics.participants ?? nodes.map((node, order) => ({ nodeId: node.id, order })))].sort((a, b) => a.order - b.order);
    const lines = ["sequenceDiagram", ...participants.flatMap((participant) => {
      const node = diagram.nodes.find((node) => node.id === participant.nodeId);
      return node ? [`participant ${ids.get(node.id)} as ${label(node.label)}`] : [];
    })];
    const messages: ProjectMermaidView["relations"] = [];
    for (const message of ordered) {
      const relation = usable.find((relation) => relation.id === message.relationId);
      if (!relation) continue;
      lines.push(`${ids.get(relation.from)}${message.kind === "return" ? "-->>" : "->>"}${ids.get(relation.to)}: ${text({ ...relation, ...(message.condition ? { condition: message.condition } : {}) })}`);
      messages.push({ key: `M${messages.length}`, id: relation.id });
    }
    return { source: lines.join("\n"), nodes, relations: messages, kind: "sequence" };
  }
  if (diagram.kind === "lifecycle") {
    const lines = ["stateDiagram-v2", "direction TB", ...diagram.nodes.map((node) => `state "${label(node.label)}" as ${ids.get(node.id)}`)];
    for (const state of diagram.semantics?.states ?? []) {
      if (!ids.has(state.nodeId)) continue;
      if (state.kind === "initial") lines.push(`[*] --> ${ids.get(state.nodeId)}`);
      if (state.kind === "terminal") lines.push(`${ids.get(state.nodeId)} --> [*]`);
    }
    for (const relation of usable) {
      const transition = diagram.semantics?.transitions?.find((transition) => transition.relationId === relation.id);
      lines.push(`${ids.get(relation.from)} --> ${ids.get(relation.to)}: ${transition?.event ? label([transition.event, transition.condition ?? relation.condition ?? ""].filter(Boolean).join(" · ")) : text(relation)}`);
    }
    return { source: lines.join("\n"), nodes, relations, kind: "state" };
  }
  const lines = ["flowchart TB"];
  const groups = diagram.kind === "data_flow" ? [...(diagram.semantics?.stages ?? [])].sort((a, b) => a.order - b.order).map((stage) => ({ label: stage.label, ids: diagram.nodes.filter((node) => node.stageId === stage.id).map((node) => node.id) }))
    : diagram.kind === "architecture" ? (diagram.semantics?.boundaries ?? []).map((boundary) => ({ label: boundary.label, ids: boundary.nodeIds }))
      : diagram.kind === "workflow" ? (diagram.semantics?.lanes ?? []).map((lane) => ({ label: lane.label, ids: diagram.nodes.filter((node) => node.laneId === lane.id).map((node) => node.id) })) : [];
  const emitted = new Set<string>();
  const nodeLine = (id: string): string => {
    const node = diagram.nodes.find((node) => node.id === id)!;
    emitted.add(id);
    return node.role === "store" ? `${ids.get(id)}[("${label(node.label)}")]` : `${ids.get(id)}["${label(node.label)}"]`;
  };
  groups.forEach((group, index) => {
    const members = group.ids.filter((id) => ids.has(id) && !emitted.has(id));
    if (members.length) lines.push(`subgraph G${index}["${label(group.label)}"]`, ...members.map(nodeLine), "end");
  });
  lines.push(...diagram.nodes.filter((node) => !emitted.has(node.id)).map((node) => nodeLine(node.id)));
  usable.forEach((relation, index) => lines.push(`${ids.get(relation.from)} E${index}@${relation.exception ? "-.->" : "-->"}|"${text(relation)}"| ${ids.get(relation.to)}`));
  return { source: lines.join("\n"), nodes, relations, kind: "flowchart", ...(diagram.kind === "sequence" ? { note: "Message order was not recorded. This view shows the saved relationships." } : {}) };
}
