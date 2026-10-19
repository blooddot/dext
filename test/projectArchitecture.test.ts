import { describe, expect, it } from "vitest";
import { architectureRuleReport, evaluateArchitectureRules } from "../src/core/projectArchitecture.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";

function semanticDiagram(): ProjectDiagram {
  const evidence = [{ path: "src/a.ts", line: 1 }];
  return {
    schemaVersion: 1, id: "arch", title: "Architecture", kind: "architecture", version: 1, updatedAt: 1,
    nodes: [
      { id: "a", label: "A", role: "system", semanticIds: [], evidence },
      { id: "b", label: "B", role: "service", semanticIds: [], evidence },
      { id: "c", label: "C", role: "store", semanticIds: [], evidence }
    ],
    relations: [
      { id: "ab", from: "a", to: "b", kind: "depends_on", evidence },
      { id: "ba", from: "b", to: "a", kind: "depends_on", evidence },
      { id: "ac", from: "a", to: "c", kind: "depends_on", evidence }
    ]
  };
}

describe("architecture rules", () => {
  it("detects a cycle and a denied relation on the explicit semantic diagram", () => {
    const violations = evaluateArchitectureRules(semanticDiagram(), [
      { id: "cycle", type: "no_cycles", from: "*" },
      { id: "deny", type: "deny", from: "a", to: "b" }
    ]);
    expect(violations.map((violation) => violation.ruleId).sort()).toEqual(["cycle", "deny"]);
    expect(violations.every((violation) => violation.nodeIds.length >= 2)).toBe(true);
  });

  it("flags dependencies outside an allowed boundary and keeps to a stable direction", () => {
    const violations = evaluateArchitectureRules(semanticDiagram(), [{ id: "allow", type: "allow", from: "a", to: "b", reason: "A may only use B." }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ ruleId: "allow", nodeIds: ["a", "c"] });
  });

  it("returns no violations for a matching rule set", () => {
    expect(evaluateArchitectureRules(semanticDiagram(), [{ id: "deny", type: "deny", from: "c", to: "a" }])).toEqual([]);
  });

  it("picks the diagram declared rules belong to and explains when it cannot", () => {
    const architecture = semanticDiagram();
    // The workflow has different edges, so the evaluated diagram is identifiable from the result.
    const workflow: ProjectDiagram = { ...architecture, id: "flow", kind: "workflow", relations: [{ id: "bc", from: "b", to: "c", kind: "calls", evidence: [] }] };
    const deny = { id: "deny", type: "deny" as const, from: "a", to: "b" };

    // No rules: nothing to evaluate, so the page shows no section at all.
    expect(architectureRuleReport([architecture], { rules: [] })).toBeUndefined();

    // A declared diagram wins, even when it is not the architecture kind.
    expect(architectureRuleReport([architecture, workflow], { diagramId: "flow", rules: [deny] })).toMatchObject({ diagramId: "flow", diagramVersion: 1, violations: [] });
    expect(architectureRuleReport([architecture], { diagramId: "arch", rules: [deny] })?.violations.map((violation) => violation.ruleId)).toEqual(["deny"]);

    // A single architecture diagram is the default target.
    const report = architectureRuleReport([architecture, workflow], { rules: [deny] });
    expect(report).toMatchObject({ diagramId: "arch", diagramVersion: 1 });
    expect(report?.violations.map((violation) => violation.ruleId)).toEqual(["deny"]);

    // Two candidates are ambiguous rather than evaluated against a guess.
    const second: ProjectDiagram = { ...architecture, id: "arch2" };
    const ambiguous = architectureRuleReport([architecture, second], { rules: [deny] });
    expect(ambiguous?.violations).toEqual([]);
    expect(ambiguous?.note).toContain("diagramId");

    expect(architectureRuleReport([workflow], { rules: [deny] })?.note).toContain("no architecture diagram");
    expect(architectureRuleReport([architecture], { diagramId: "missing", rules: [deny] })?.note).toContain("missing");
  });
});
