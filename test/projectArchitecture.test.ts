import { describe, expect, it } from "vitest";
import { architectureRuleReport, evaluateArchitectureRules } from "../src/core/projectArchitecture.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";
import { renderArchitectureView } from "../src/webview/projectArchitectureView.js";

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

describe("diagrams page", () => {
  const summaries = [
    { id: "d1", title: "订单流程", kind: "workflow" as const, version: 3, updatedAt: 1 },
    { id: "d2", title: "示例架构", kind: "architecture" as const, version: 1, updatedAt: 2 }
  ];

  it("lists saved diagrams with per-diagram actions and no renderer preferences", () => {
    const html = renderArchitectureView({ diagrams: summaries, selected: summaries[1]!, engine: { id: "archify", version: "2.17.0-dev.1+d673e830", available: true } });
    expect(html).toContain("data-diagram-select");
    expect(html).toContain('data-diagram-action="refresh"');
    expect(html).toContain('data-diagram-action="export"');
    expect(html).toContain('data-diagram-action="fullscreen"');
    // The sandboxed viewer needs the fullscreen permission, and focus mode needs its own exit.
    expect(html).toContain('allow="fullscreen"');
    expect(html).toContain('data-diagram-action="exit-fullscreen"');
    // A card click shows node details in place instead of jumping into an evidence file.
    expect(html).toContain("data-diagram-node");
    expect(html).toContain("data-diagram-node-evidence");
    expect(html).toContain('data-diagram-action="close-node"');
    expect(html).toContain("Workflow");
    expect(html).not.toContain("data-project-adapter-select");
    expect(html).not.toContain("Use recommended");
    expect(html).not.toContain("Fallback:");
  });

  it("shows an empty state and a generation entry instead of a fake diagram", () => {
    const html = renderArchitectureView({ diagrams: [] });
    expect(html).toContain("No diagram generated yet");
    expect(html).toContain("data-diagram-generate-new");
    expect(html).toContain("data-diagram-empty");
    expect(html).not.toContain("architecture-graph-scroll");
    expect(html).not.toContain("data-module-id");
  });

  it("renders what the last evidence read handed the model, with clickable paths", () => {
    const evidence = {
      version: 1 as const, trigger: "initialize" as const, generatedAt: 1_700_000_000_000, inputHash: "hash",
      selection: { scope: [], preset: "standard", files: 600, fileChars: 16_000, evidenceChars: 600_000 },
      inventory: { total: 3, withSymbols: 2, byKind: { source: 3 } },
      excerpts: { total: 2, truncated: 1, byKind: { source: 2 } },
      omitted: { files: 1, objects: 0, knowledge: 0 },
      coverage: ["Source text exceeds the limit."],
      paths: ["src/app.ts", "src/core/deep.ts", "src/other.ts"],
      excerpted: ["src/app.ts", "src/core/deep.ts"]
    };
    const html = renderArchitectureView({ diagrams: summaries, selected: summaries[1]!, evidence });
    expect(html).toContain("data-diagram-evidence");
    expect(html).toContain("data-evidence-scope");
    expect(html).toContain("standard");
    expect(html).toContain("built-in (README, documentation, manifests, source)");
    expect(html).toContain("Read in full or in part (2)");
    expect(html).toContain("Listed without an excerpt (1)");
    expect(html).toContain('data-evidence-path="src/other.ts"');
    expect(html).toContain("Source text exceeds the limit.");
    // Without a record the section stays hidden instead of claiming a run that never happened.
    expect(renderArchitectureView({ diagrams: summaries })).toContain('data-diagram-evidence hidden');
  });

  it("labels a last-good render with the version actually shown", () => {
    const html = renderArchitectureView({
      diagrams: summaries,
      selected: summaries[1]!,
      render: { diagramId: "d2", requestedVersion: 2, displayedVersion: 1, usedLastGood: true, status: "failed", issues: [] }
    });
    expect(html).toContain("v1");
    expect(html).toContain("last successful result");
  });

  it("marks an uninitialized knowledge model without hiding saved diagrams", () => {
    const html = renderArchitectureView({ diagrams: summaries, selected: summaries[1]!, knowledgeUninitialized: true });
    expect(html).toContain("Project knowledge is not initialized");
    expect(html).toContain("data-diagram-frame");
  });

  it("reports declared rules and their violations without claiming a baseline", () => {
    const rules = [{ id: "no-ui-db", type: "deny" as const, from: "ui", to: "db", reason: "UI writes through the API." }];
    const violations = [{ ruleId: "no-ui-db", nodeIds: ["ui", "db"], reason: "Denied architecture dependency." }];

    const current = renderArchitectureView({ diagrams: summaries, selected: summaries[1]!, rules, violations });
    expect(current).toContain("architecture-rules");
    expect(current).toContain("no-ui-db");
    expect(current).toContain("Violations (1)");
    // Nothing was accepted as a baseline, so the current violations are not labelled as new ones.
    expect(current).not.toContain("New violations");

    const withBaseline = renderArchitectureView({ diagrams: summaries, selected: summaries[1]!, rules, violations, baselineViolations: violations });
    expect(withBaseline).toContain("New violations (1)");
    expect(withBaseline).toContain("Existing baseline violations (1)");

    const noted = renderArchitectureView({ diagrams: [], rules, rulesNote: "Rules are declared but no architecture diagram is saved yet." });
    expect(noted).toContain("no architecture diagram is saved yet");
    expect(noted).not.toContain("architecture-violations");

    // No rules, no violations and no note: the section is left out entirely.
    expect(renderArchitectureView({ diagrams: summaries })).not.toContain("architecture-rules");
  });
});
