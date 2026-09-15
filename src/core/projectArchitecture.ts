export type ProjectLanguage = "typescript" | "python" | "rust" | "unknown";
export type ArchitectureRelationSource = "detected" | "declared" | "inferred" | "unknown";

export interface ArchitectureModule {
  id: string;
  name: string;
  language: ProjectLanguage;
  paths: string[];
  source: ArchitectureRelationSource;
}

export interface ArchitectureRelation {
  from: string;
  to: string;
  source: ArchitectureRelationSource;
  confidence: number;
  file?: string;
  line?: number;
  reason?: string;
}

export interface ArchitectureScanResult {
  modules: ArchitectureModule[];
  relations: ArchitectureRelation[];
  unsupported: { path: string; reason: string }[];
  parserVersions: Partial<Record<ProjectLanguage, string>>;
  /** Scan-wide limitations, such as project metadata that could not be resolved. */
  coverage?: string[];
  /** Bounded source excerpts retained by workspace hosts for optional AI evidence generation. */
  files?: readonly { path: string; content: string }[];
}

export interface ArchitectureRule {
  id: string;
  type: "allow" | "deny" | "no_cycles";
  from: string;
  to?: string;
  reason?: string;
}

export interface ArchitectureViolation {
  ruleId: string;
  relation?: ArchitectureRelation;
  moduleIds: string[];
  reason: string;
}

export function evaluateArchitectureRules(result: ArchitectureScanResult, rules: readonly ArchitectureRule[]): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  for (const rule of rules) {
    if (rule.type === "deny") {
      for (const relation of result.relations) {
        if (relation.from === rule.from && relation.to === rule.to) violations.push({ ruleId: rule.id, relation, moduleIds: [relation.from, relation.to], reason: rule.reason ?? "Denied architecture dependency." });
      }
    }
    if (rule.type === "allow" && rule.to) {
      for (const relation of result.relations) {
        if (relation.from === rule.from && relation.to !== rule.to) violations.push({ ruleId: rule.id, relation, moduleIds: [relation.from, relation.to], reason: rule.reason ?? "Dependency is outside the allowed boundary." });
      }
    }
  }
  for (const rule of rules.filter((item) => item.type === "no_cycles")) {
    const graph = new Map<string, string[]>();
    for (const relation of result.relations) graph.set(relation.from, [...(graph.get(relation.from) ?? []), relation.to]);
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (node: string, path: string[]): void => {
      if (visiting.has(node)) {
        const cycle = [...path.slice(path.indexOf(node)), node];
        violations.push({ ruleId: rule.id, moduleIds: cycle, reason: "Architecture dependency cycle detected." });
        return;
      }
      if (visited.has(node)) return;
      visiting.add(node);
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
      visiting.delete(node); visited.add(node);
    };
    for (const module of result.modules) visit(module.id, []);
  }
  return violations;
}
