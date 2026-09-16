import type { ProjectDiagram } from "./projectDiagram.js";

/**
 * Declared architecture rules. Rules always consume an explicit semantic diagram; they never
 * depend on a source scan, import graph or language-specific parser.
 */
export interface ArchitectureRule {
  id: string;
  type: "allow" | "deny" | "no_cycles";
  /** Stable Project node id from the saved diagram. */
  from: string;
  to?: string | undefined;
  reason?: string | undefined;
}

export interface ArchitectureViolation {
  ruleId: string;
  /** The relation that violated the rule; absent for rule shapes that do not map to one edge. */
  relation?: { id: string; from: string; to: string; label?: string };
  nodeIds: string[];
  reason: string;
}

/** Declared rules plus the diagram they were authored against. */
export interface DeclaredArchitectureRules {
  /** Diagram the rule node ids belong to. Omitted selects the only architecture diagram. */
  diagramId?: string;
  rules: readonly ArchitectureRule[];
}

export interface ArchitectureRuleReport {
  diagramId: string;
  diagramVersion: number;
  rules: readonly ArchitectureRule[];
  violations: readonly ArchitectureViolation[];
  /** Why rules could not be evaluated against a diagram, when that is the case. */
  note?: string;
}

/**
 * Evaluates the declared rules against the diagram they belong to.
 *
 * Rules reference stable Project node ids, so they are only meaningful for one diagram. The declared
 * `diagramId` selects it; without one, a single saved architecture diagram is used, and anything
 * ambiguous is reported as a note instead of being evaluated against the wrong diagram.
 */
export function architectureRuleReport(
  diagrams: readonly ProjectDiagram[],
  declared: DeclaredArchitectureRules
): ArchitectureRuleReport | undefined {
  if (!declared.rules.length) return undefined;
  const architectureDiagrams = diagrams.filter((diagram) => diagram.kind === "architecture");
  const selected = declared.diagramId
    ? diagrams.find((diagram) => diagram.id === declared.diagramId)
    : architectureDiagrams.length === 1 ? architectureDiagrams[0] : undefined;
  if (!selected) {
    const note = declared.diagramId
      ? `Rules are declared for diagram '${declared.diagramId}', which is not saved in this project.`
      : architectureDiagrams.length
        ? "Rules are evaluated against one diagram; set `diagramId` in .dext/architecture.json to choose it."
        : "Rules are declared but no architecture diagram is saved yet.";
    return { diagramId: declared.diagramId ?? "", diagramVersion: 0, rules: declared.rules, violations: [], note };
  }
  return {
    diagramId: selected.id,
    diagramVersion: selected.version,
    rules: declared.rules,
    violations: evaluateArchitectureRules(selected, declared.rules)
  };
}

/**
 * Evaluates declared rules against the saved semantic diagram. `from`/`to` are stable Project
 * node ids, so a rule keeps working when Archify ids or layout change.
 */
export function evaluateArchitectureRules(diagram: ProjectDiagram, rules: readonly ArchitectureRule[]): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  const relations = diagram.relations.map((relation) => ({
    id: relation.id,
    from: relation.from,
    to: relation.to,
    ...(relation.label ? { label: relation.label } : {})
  }));
  for (const rule of rules) {
    if (rule.type === "deny") {
      for (const relation of relations) {
        if (relation.from === rule.from && relation.to === rule.to) {
          violations.push({ ruleId: rule.id, relation, nodeIds: [relation.from, relation.to], reason: rule.reason ?? "Denied architecture dependency." });
        }
      }
    }
    if (rule.type === "allow" && rule.to) {
      for (const relation of relations) {
        if (relation.from === rule.from && relation.to !== rule.to) {
          violations.push({ ruleId: rule.id, relation, nodeIds: [relation.from, relation.to], reason: rule.reason ?? "Dependency is outside the allowed boundary." });
        }
      }
    }
  }
  for (const rule of rules.filter((item) => item.type === "no_cycles")) {
    const graph = new Map<string, string[]>();
    for (const relation of relations) graph.set(relation.from, [...(graph.get(relation.from) ?? []), relation.to]);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: string, path: string[]): void => {
      if (visiting.has(node)) {
        const cycle = [...path.slice(path.indexOf(node)), node];
        violations.push({ ruleId: rule.id, nodeIds: cycle, reason: "Architecture dependency cycle detected." });
        return;
      }
      if (visited.has(node)) return;
      visiting.add(node);
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
      visiting.delete(node);
      visited.add(node);
    };
    for (const node of diagram.nodes) visit(node.id, []);
  }
  return violations;
}
