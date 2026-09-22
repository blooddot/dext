import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { ArchifyAdapter } from "../src/core/archifyAdapter.js";
import type { ProjectDiagram, ProjectDiagramEvidence, ProjectDiagramNode, ProjectDiagramRelation } from "../src/core/projectDiagram.js";

/**
 * The diagrams a real Project produces are much larger than the small fixtures the
 * adapter's own tests use, and every one of these shapes used to be rejected by the
 * vendored renderers: the builders fed them geometry their fixed grids cannot hold
 * (overlapping grid cells, boxes wider than the stage pitch, a lifecycle band with no
 * route left to the outcome band). Each case here renders the real thing.
 */
const runtimeRoot = resolve("vendor/project-diagrams/archify");
const evidence = (path: string): ProjectDiagramEvidence[] => [{ path, line: 1 }];
const node = (id: string, label: string, role: ProjectDiagramNode["role"], description: string, extra: Record<string, unknown> = {}): ProjectDiagramNode => ({
  id, label, role, description, semanticIds: [], evidence: evidence(`src/${id}.ts`), ...extra
});
const relation = (id: string, from: string, to: string, kind: ProjectDiagramRelation["kind"], extra: Record<string, unknown> = {}): ProjectDiagramRelation => ({
  id, from, to, kind, evidence: evidence(`src/${id}.ts`), ...extra
});
const base = { schemaVersion: 1 as const, version: 1, updatedAt: 1, confidence: 0.8, review: "draft" as const, freshness: "current" as const };

/** Seven participants with sentence-long descriptions, and ten messages. */
const sequence: ProjectDiagram = {
  ...base, id: "wide-sequence", title: "Typed agent call across the webview boundary", kind: "sequence",
  nodes: [
    node("sq.webview", "Dext Webview (composer)", "actor", "Collects the request and later renders the turn."),
    node("sq.sidebar", "Conversation provider (host)", "component", "Receives webview requests and owns the conversation turn."),
    node("sq.runtime", "WorkflowRuntime", "component", "Executes the compiled steps of the document."),
    node("sq.router", "DefaultAgentRunner", "service", "Chooses and invokes the backend for the turn."),
    node("sq.cli", "codex / claude CLI", "component", "External provider process that produces the answer text."),
    node("sq.harness", "DeepSeek Harness", "component", "Alternative provider session used when the profile selects it."),
    node("sq.answers", "Agent input broker", "component", "Resolves a pending question with the answers the reader gave.")
  ],
  relations: Array.from({ length: 10 }, (_, index) => relation(`sq.m${index}`, index % 2 === 0 ? "sq.webview" : "sq.sidebar", index % 3 === 0 ? "sq.runtime" : "sq.router", index % 4 === 3 ? "returns" : "calls", { label: `message ${index}`, order: index + 1, condition: index % 3 === 0 ? "the document compiles" : undefined })),
  semantics: {
    participants: ["sq.webview", "sq.sidebar", "sq.runtime", "sq.router", "sq.cli", "sq.harness", "sq.answers"].map((nodeId, order) => ({ nodeId, order })),
    messages: Array.from({ length: 10 }, (_, index) => ({ relationId: `sq.m${index}`, order: index + 1, kind: index % 4 === 3 ? "return" as const : "call" as const, evidence: evidence(`m${index}`) }))
  }
};

/** Twenty-two components wired by ten connections, as a real codebase's architecture is. */
const architecture: ProjectDiagram = {
  ...base, id: "layered-architecture", title: "Dext layered architecture", kind: "architecture",
  nodes: Array.from({ length: 22 }, (_, index) => node(`arch.n${index}`, `Component ${index + 1} with a descriptive label`, index % 5 === 0 ? "store" : "service", "A component whose description is long enough to need its own sublabel budget.")),
  relations: Array.from({ length: 10 }, (_, index) => relation(`arch.r${index}`, `arch.n${index}`, `arch.n${index + 6}`, index % 3 === 0 ? "reads" : "calls", { label: `writes, runs and answers ${index}`, order: index + 1 })),
  semantics: { boundaries: [{ id: "core", label: "Core", kind: "region", nodeIds: ["arch.n0", "arch.n1", "arch.n2"], evidence: evidence("core") }] }
};

/** Eighteen steps over four lanes, which used to collide two to a cell. */
const workflow: ProjectDiagram = {
  ...base, id: "turn-workflow", title: "Agent turn execution workflow", kind: "workflow",
  nodes: Array.from({ length: 18 }, (_, index) => node(`wf.n${index}`, `Step ${index + 1}`, index % 4 === 0 ? "actor" : "service", "What this step does.", { laneId: ["core", "provider", "host", "failure"][index % 4]! })),
  relations: Array.from({ length: 17 }, (_, index) => relation(`wf.e${index}`, `wf.n${index}`, `wf.n${index + 1}`, index % 5 === 4 ? "returns" : "calls", { label: `edge ${index}`, order: index + 1 })),
  semantics: {
    lanes: ["core", "provider", "host", "failure"].map((id) => ({
      id, label: id, evidence: evidence(id),
      ...(id === "failure" ? { variant: "exception" as const } : {})
    })),
    mainPath: Array.from({ length: 18 }, (_, index) => `wf.n${index}`)
  }
};

/** Nine nodes across five stages with eight flows, three of them inside one stage. */
const dataFlow: ProjectDiagram = {
  ...base, id: "project-knowledge-data-flow", title: "Project knowledge generation data flow", kind: "data_flow",
  nodes: [
    node("df.files", "candidate evidence files", "store", "Every file the workspace scan considered.", { stageId: "s0" }),
    node("df.filter", "included excerpts and inventory", "service", "The subset the filters kept.", { stageId: "s0" }),
    node("df.objects", "generated model content", "store", "The knowledge the model wrote.", { stageId: "s1" }),
    node("df.package", "packaged knowledge", "store", "The knowledge as the reader receives it.", { stageId: "s1" }),
    node("df.suggestions", "decision per suggestion", "service", "One decision per proposed diagram.", { stageId: "s2" }),
    node("df.decisions", "items awaiting a human decision", "event", "Suggestions a person has to judge.", { stageId: "s2" }),
    node("df.validation", "validated objects", "service", "Objects that satisfy the schema.", { stageId: "s3" }),
    node("df.store", "knowledge store", "store", "Where the accepted knowledge lands.", { stageId: "s4" }),
    node("df.rel", "workflow relationship container", "component", "Where the diagram edges land.", { stageId: "s4" })
  ],
  relations: [
    relation("df.r1", "df.files", "df.filter", "reads", { label: "candidate evidence files", order: 1 }),
    relation("df.r2", "df.filter", "df.package", "writes", { label: "included excerpts and inventory", order: 2 }),
    relation("df.r3", "df.objects", "df.suggestions", "flows_to", { label: "generated model content", order: 3 }),
    relation("df.r4", "df.suggestions", "df.decisions", "flows_to", { label: "decision per suggestion", order: 4 }),
    relation("df.r5", "df.decisions", "df.validation", "flows_to", { label: "items awaiting a human decision", order: 5 }),
    relation("df.r6", "df.validation", "df.store", "writes", { label: "validated objects", order: 6 }),
    relation("df.r7", "df.validation", "df.rel", "writes", { label: "validated objects", order: 7 }),
    relation("df.r8", "df.store", "df.rel", "depends_on", { label: "load order", order: 8 })
  ],
  semantics: {
    stages: ["s0", "s1", "s2", "s3", "s4"].map((id, order) => ({ id, label: `stage ${order + 1}`, order, evidence: evidence(id) }))
  }
};

/** Nine states and eleven transitions: more than the fixed lifecycle bands can route. */
const lifecycle: ProjectDiagram = {
  ...base, id: "editor-tab-lifecycle", title: "Editor tab lifecycle", kind: "lifecycle",
  nodes: ["ls.absent", "ls.keyKnown", "ls.opened", "ls.reused", "ls.pending", "ls.adopted", "ls.skipped", "ls.invalid", "ls.closed"]
    .map((id, index) => node(id, `State ${index + 1} with a longer label`, "state", "What this state means for the reader.", { laneId: index < 7 ? "main" : "terminal" })),
  relations: Array.from({ length: 11 }, (_, index) => relation(`ls.t${index}`, index === 0 ? "ls.absent" : `ls.${["keyKnown", "opened", "reused", "pending", "adopted", "skipped", "invalid", "closed"][(index - 1) % 8]!}`, `ls.${["keyKnown", "opened", "reused", "pending", "adopted", "skipped", "invalid", "closed"][index % 8]!}`, "transitions", { label: `transition ${index}`, order: index + 1 })),
  semantics: {
    lanes: [{ id: "main", label: "Stages", evidence: evidence("main") }, { id: "terminal", label: "Result", evidence: evidence("terminal") }],
    states: [
      { nodeId: "ls.absent", kind: "initial", evidence: evidence("ls.absent") },
      ...["ls.keyKnown", "ls.opened", "ls.reused", "ls.pending", "ls.adopted", "ls.skipped"].map((nodeId) => ({ nodeId, kind: "normal" as const, evidence: evidence(nodeId) })),
      { nodeId: "ls.invalid", kind: "terminal", outcome: "failure" as const, evidence: evidence("ls.invalid") },
      { nodeId: "ls.closed", kind: "terminal", outcome: "success" as const, evidence: evidence("ls.closed") }
    ],
    transitions: Array.from({ length: 11 }, (_, index) => ({ relationId: `ls.t${index}`, event: `transition ${index}`, evidence: evidence(`ls.t${index}`) }))
  }
};

/** More non-terminal states than the rail (5) and the event band (3 x 2) can hold. */
const oversizedLifecycle: ProjectDiagram = {
  ...base, id: "oversized-lifecycle", title: "Oversized lifecycle", kind: "lifecycle",
  nodes: Array.from({ length: 12 }, (_, index) => node(`os.n${index}`, `State ${index + 1}`, "state", "What this state means.", { laneId: "main" })),
  relations: Array.from({ length: 11 }, (_, index) => relation(`os.t${index}`, `os.n${index}`, `os.n${index + 1}`, "transitions", { label: `transition ${index}`, order: index + 1 })),
  semantics: {
    lanes: [{ id: "main", label: "Stages", evidence: evidence("main") }],
    states: Array.from({ length: 12 }, (_, index) => ({ nodeId: `os.n${index}`, kind: index === 0 ? "initial" as const : "normal" as const, evidence: evidence(`os.n${index}`) })),
    transitions: Array.from({ length: 11 }, (_, index) => ({ relationId: `os.t${index}`, event: `transition ${index}`, evidence: evidence(`os.t${index}`) }))
  }
};

describe("Archify layout for full-size Project diagrams", { timeout: 180_000 }, () => {
  it.each([
    ["sequence", sequence],
    ["architecture", architecture],
    ["workflow", workflow],
    ["data_flow", dataFlow],
    // Nine states and eleven transitions: three of them share the event band, which
    // leaves one free column for the two terminal exits.
    ["lifecycle", lifecycle]
  ] as const)("renders the %s diagram a real Project produces", async (_kind, diagram) => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    try {
      const artifact = await adapter.render(await adapter.transform(diagram));
      expect(String(artifact.content)).toContain("<!DOCTYPE html>");
    } finally { adapter.dispose(); }
  });

  it("names the fixed lifecycle bands when a lifecycle exceeds them", async () => {
    const adapter = new ArchifyAdapter(runtimeRoot);
    try {
      await expect((async () => adapter.render(await adapter.transform(oversizedLifecycle)))())
        .rejects.toThrow(/phase and event bands can hold/);
    } finally { adapter.dispose(); }
  });
});
