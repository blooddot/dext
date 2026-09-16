import { describe, expect, it } from "vitest";
import {
  buildProjectEvidencePackage,
  parseProjectAiResponse,
  parseProjectDiagramResponse,
  ProjectAiGenerationError,
  ProjectAiGenerationService,
  validateDiagramSemantics,
  validateProjectAiModel,
  type ProjectAiActivityEvent,
  type ProjectAiGeneratedModel,
  type ProjectAiProvider,
  type ProjectEvidencePackage
} from "../src/core/projectAiGeneration.js";
import { projectIntentSchema } from "../src/core/projectIntent.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";

const files = [
  { path: "README.md", content: "# Example\nA task application." },
  { path: "package.json", content: '{"name":"example"}' },
  { path: "src/app.ts", content: "export function start() {}\n", symbols: ["start"] },
  { path: ".env", content: "API_KEY=should-not-be-included" },
  { path: "../outside.ts", content: "secret" },
  { path: "node_modules/pkg/index.js", content: "module.exports = {}" }
] as const;

const evidence = (requirement?: string): ProjectEvidencePackage => buildProjectEvidencePackage({
  projectName: "Example",
  files,
  ...(requirement ? { requirement } : {}),
  knowledge: [{ id: "task.context", kind: "context", name: "TaskApplication" }]
});

const intent = (input: ProjectEvidencePackage) => projectIntentSchema.parse({
  schemaVersion: 1,
  brief: { name: "Example", summary: "Task application", evidence: [{ path: "README.md", line: 1, contentHash: input.files.find((file) => file.path === "README.md")!.contentHash }] },
  contexts: [{ id: "task.context", canonicalName: "TaskApplication", purpose: "Application boundary", evidence: [{ path: "src/app.ts", line: 1 }] }],
  updatedAt: 1
});

const architectureDiagram = (): ProjectDiagram => ({
  schemaVersion: 1, id: "architecture", title: "Architecture", kind: "architecture",
  nodes: [
    { id: "app", label: "Application", role: "system", semanticIds: ["task.context"], evidence: [{ path: "src/app.ts", line: 1 }] }
  ],
  relations: [], version: 0, updatedAt: 1
});

const validModel = (input: ProjectEvidencePackage): ProjectAiGeneratedModel => ({ intent: intent(input), diagrams: [architectureDiagram()] });

describe("Project evidence package", () => {
  it("bounds files, redacts secrets and keeps a deterministic hash without any scan contract", () => {
    const first = evidence();
    const second = evidence();
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.files.map((file) => file.path)).not.toContain(".env");
    expect(first.files.map((file) => file.path)).not.toContain("../outside.ts");
    expect(first.files.map((file) => file.path)).not.toContain("node_modules/pkg/index.js");
    expect(first.files.find((file) => file.path === "README.md")?.text).toContain("Example");
    expect(first.omitted.files).toBe(3);
    expect(first.knowledge).toEqual([{ id: "task.context", kind: "context", name: "TaskApplication" }]);
    expect("modules" in first).toBe(false);
    expect("parserVersions" in first).toBe(false);
    expect("relations" in first).toBe(false);
  });

  it("enforces budgets and carries the explicit diagram requirement", () => {
    const bounded = buildProjectEvidencePackage({ projectName: "Example", files, requirement: "订单流程" }, { maxFileChars: 64, maxTotalChars: 2_048, maxFiles: 2 });
    expect(bounded.files.length).toBeLessThanOrEqual(2);
    expect(bounded.characterCount).toBeLessThanOrEqual(2_048);
    expect(bounded.omitted.files).toBeGreaterThan(0);
    expect(bounded.requirement).toBe("订单流程");
  });

  it("rejects invalid limits instead of silently changing the contract", () => {
    expect(() => buildProjectEvidencePackage({ projectName: "Example", files }, { maxFiles: 0 })).toThrowError(ProjectAiGenerationError);
  });
});

describe("kind-specific diagram semantics", () => {
  const withSemantics = (kind: ProjectDiagram["kind"], semantics: NonNullable<ProjectDiagram["semantics"]>, nodes = architectureDiagram().nodes): ProjectDiagram => ({
    ...architectureDiagram(), id: `demo-${kind}`, kind, nodes, semantics
  });
  const evidenceEntry = [{ path: "src/app.ts", line: 1 }];

  it("requires an evidenced relation between consecutive main-path steps", () => {
    const node = (id: string) => ({ id, label: id, role: "service" as const, semanticIds: [], evidence: [{ path: "src/app.ts", line: 1 }], laneId: "main" });
    const diagram: ProjectDiagram = {
      schemaVersion: 1, id: "wf", title: "WF", kind: "workflow", version: 0, updatedAt: 0,
      nodes: [node("a"), node("b"), node("c")],
      relations: [{ id: "r1", from: "a", to: "b", kind: "calls", order: 1, evidence: [{ path: "src/app.ts", line: 1 }] }],
      semantics: { lanes: [{ id: "main", label: "Main", evidence: [{ path: "src/app.ts", line: 1 }] }], mainPath: ["a", "b", "c"] }
    };
    // Upstream walks the main path edge by edge, so a generated gap must be rejected here rather
    // than failing three render attempts later.
    expect(validateDiagramSemantics(diagram).some((error) => error.includes("mainPath step 'b' → 'c' has no relation"))).toBe(true);
    const connected = { ...diagram, relations: [...diagram.relations, { id: "r2", from: "b", to: "c", kind: "calls" as const, order: 2, evidence: [{ path: "src/app.ts", line: 1 }] }] };
    expect(validateDiagramSemantics(connected)).toEqual([]);
  });

  it("requires lanes for workflows, messages for sequences, stages for data flow and terminal states for lifecycle", () => {
    expect(validateDiagramSemantics(withSemantics("workflow", {})).some((error) => error.includes("lane"))).toBe(true);
    expect(validateDiagramSemantics(withSemantics("sequence", {})).some((error) => error.includes("participants"))).toBe(true);
    expect(validateDiagramSemantics(withSemantics("data_flow", {})).some((error) => error.includes("stages"))).toBe(true);
    expect(validateDiagramSemantics(withSemantics("lifecycle", {})).some((error) => error.includes("initial"))).toBe(true);
  });

  it("accepts complete five-kind semantic structures", () => {
    const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, role: "service" as const, semanticIds: [], evidence: evidenceEntry, ...extra });
    const relation = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, from, to, kind: "calls" as const, evidence: evidenceEntry, ...extra });
    const workflow = withSemantics("workflow", { lanes: [{ id: "lane", label: "Lane", evidence: evidenceEntry }] }, [node("a", { laneId: "lane" }), node("b", { laneId: "lane" })]);
    workflow.relations = [relation("r", "a", "b", { order: 1 })];
    expect(validateDiagramSemantics(workflow)).toEqual([]);
    expect(validateDiagramSemantics(withSemantics("sequence", { participants: [{ nodeId: "missing", order: 0 }, { nodeId: "app", order: 1 }] })).length).toBeGreaterThan(0);
    const sequence: ProjectDiagram = {
      ...architectureDiagram(), kind: "sequence",
      nodes: [node("a"), node("b")], relations: [relation("m", "a", "b")],
      semantics: { participants: [{ nodeId: "a", order: 0 }, { nodeId: "b", order: 1 }], messages: [{ relationId: "m", order: 1, kind: "call", evidence: evidenceEntry }] }
    };
    expect(validateDiagramSemantics(sequence)).toEqual([]);
    const dataFlow = withSemantics("data_flow", { stages: [{ id: "s1", label: "Source", order: 0, evidence: evidenceEntry }, { id: "s2", label: "Store", order: 1, evidence: evidenceEntry }] }, [node("a", { stageId: "s1" }), node("b", { stageId: "s2" })]);
    expect(validateDiagramSemantics(dataFlow)).toEqual([]);
    const lifecycle = withSemantics("lifecycle", { states: [{ nodeId: "a", kind: "initial", evidence: evidenceEntry }, { nodeId: "b", kind: "terminal", outcome: "success", evidence: evidenceEntry }] }, [node("a"), node("b")]);
    lifecycle.relations = [{ id: "t", from: "a", to: "b", kind: "transitions", evidence: evidenceEntry }];
    lifecycle.semantics = { ...lifecycle.semantics, transitions: [{ relationId: "t", event: "finish", evidence: evidenceEntry }] };
    expect(validateDiagramSemantics(lifecycle)).toEqual([]);
  });
});

describe("Project AI response validation", () => {
  it("accepts evidence-backed references to existing knowledge", () => {
    const input = evidence();
    expect(validateProjectAiModel(validModel(input), input)).toEqual([]);
  });

  it("rejects unknown semantic ids, missing evidence, dangling relations and incomplete kind semantics", () => {
    const input = evidence();
    const model = validModel(input);
    model.diagrams[0]!.nodes[0]!.semanticIds = ["missing"];
    expect(validateProjectAiModel(model, input).some((error) => error.includes("Unknown semantic id"))).toBe(true);

    const noEvidence = validModel(input);
    noEvidence.diagrams[0]!.nodes[0]!.evidence = [];
    expect(validateProjectAiModel(noEvidence, input).some((error) => error.includes("Source evidence is required"))).toBe(true);

    const dangling = validModel(input);
    dangling.diagrams[0]!.relations = [{ id: "r", from: "app", to: "missing", kind: "calls", evidence: [{ path: "src/app.ts" }] }];
    expect(validateProjectAiModel(dangling, input).some((error) => error.includes("dangling_relation"))).toBe(true);

    const workflow = validModel(input);
    workflow.diagrams[0] = { ...architectureDiagram(), kind: "workflow" };
    expect(validateProjectAiModel(workflow, input).some((error) => error.includes("lane"))).toBe(true);
  });

  it("parses plain, explained and intent-shaped JSON output", () => {
    const input = evidence();
    const model = validModel(input);
    const json = JSON.stringify(model);
    expect(parseProjectAiResponse(`Here is the model:\n\n${json}`, input).diagrams[0]!.id).toBe("architecture");
    expect(parseProjectAiResponse(`\`\`\`json\n${json}\n\`\`\``, input).intent.brief.name).toBe("Example");
    expect(parseProjectAiResponse(JSON.stringify({ ...model.intent, diagrams: model.diagrams }), input).intent.contexts[0]!.id).toBe("task.context");
    expect(() => parseProjectAiResponse("not json", input)).toThrowError(ProjectAiGenerationError);
  });

  it("parses a single on-demand diagram response", () => {
    const input = evidence("Show the architecture");
    const parsed = parseProjectDiagramResponse(JSON.stringify({ diagram: architectureDiagram() }), input);
    expect(parsed.diagram.id).toBe("architecture");
  });
});

describe("Project AI generation service", () => {
  it("retries invalid output and stamps inferred draft provenance", async () => {
    const input = evidence();
    const value = validModel(input);
    let calls = 0;
    const provider: ProjectAiProvider = { id: "mock", generate: async () => ({ text: ++calls === 1 ? "{}" : JSON.stringify(value), model: "mock-model" }) };
    const result = await new ProjectAiGenerationService(provider, { timeoutMs: 2_000, now: () => 42 }).generate(input);
    expect(calls).toBe(2);
    expect(result.metadata.attempts).toBe(2);
    expect(result.metadata.promptVersion).toBe("project-knowledge-2");
    expect(result.intent.brief.origin).toBe("inferred");
    expect(result.intent.brief.review).toBe("draft");
    expect(result.intent.generatedAt).toBe(42);
    expect(result.diagrams[0]!.version).toBe(0);
  });

  it("keeps the confidence the model reported for each statement", async () => {
    const input = evidence();
    const value: ProjectAiGeneratedModel = {
      intent: {
        ...validModel(input).intent,
        brief: { ...validModel(input).intent.brief, confidence: 0.9 },
        capabilities: [{ id: "task.query", canonicalName: "TaskQuery", description: "Runs a query.", outcomes: [], contextIds: [], moduleIds: [], evidence: [{ path: "src/app.ts", line: 1 }], confidence: 0.8 } as never]
      },
      diagrams: []
    };
    const provider: ProjectAiProvider = { id: "mock", generate: async () => ({ text: JSON.stringify(value) }) };
    const result = await new ProjectAiGenerationService(provider).generate(input);
    // Stamping provenance must not overwrite the model's estimate with a constant.
    expect(result.intent.brief.confidence).toBe(0.9);
    expect(result.intent.capabilities[0]!.confidence).toBe(0.8);
  });

  it("reports live activities, terminal provider errors and cancellation", async () => {
    const input = evidence();
    const events: ProjectAiActivityEvent[] = [];
    const value = validModel(input);
    const provider: ProjectAiProvider = {
      id: "mock",
      generate: async (request) => {
        request.onEvent?.({ id: "cli-output", phase: "message", text: "Preparing the model." });
        return { text: request.attempt === 1 ? "{}" : JSON.stringify(value) };
      }
    };
    await new ProjectAiGenerationService(provider).generate(input, { onEvent: (event) => events.push(event) });
    expect(events.some((event) => event.id === "cli-output")).toBe(true);
    expect(events.some((event) => event.title === "AI analysis attempt failed" && event.done)).toBe(true);
    expect(events.some((event) => event.title === "Retrying AI analysis")).toBe(true);

    const failing: ProjectAiProvider = { id: "failed", generate: async () => ({ text: "CLI authentication expired.", finishReason: "error" }) };
    await expect(new ProjectAiGenerationService(failing, { maxAttempts: 1 }).generate(input)).rejects.toMatchObject({ code: "provider_error", diagnostics: ["CLI authentication expired."] });

    const hanging: ProjectAiProvider = { id: "hanging", generate: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) };
    const controller = new AbortController();
    const promise = new ProjectAiGenerationService(hanging, { timeoutMs: 10_000 }).generate(input, { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    await expect(new ProjectAiGenerationService(undefined).generate(input)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("generates one on-demand diagram of the requested kind without touching other artifacts", async () => {
    const requirement = "展示订单处理架构";
    const input = evidence(requirement);
    const provider: ProjectAiProvider = { id: "mock", generate: async () => ({ text: JSON.stringify({ diagram: architectureDiagram() }) }) };
    const result = await new ProjectAiGenerationService(provider).generateDiagram(input, { requirement, kind: "architecture" });
    expect(result.diagram.id).toBe("architecture");
    expect(result.diagram.kind).toBe("architecture");
    expect(result.diagram.version).toBe(0);
    expect(result.metadata.promptVersion).toBe("project-diagram-1");
  });

  it("accepts a requirement the evidence package truncated to its own budget", async () => {
    const requirement = "展示订单处理架构，包括下单、支付、履约与退款等所有关键子流程";
    const input = buildProjectEvidencePackage({
      projectName: "Example", files, requirement,
      knowledge: [{ id: "task.context", kind: "context", name: "TaskApplication" }]
    }, { maxRequirementChars: 12 });
    expect(input.requirement!.length).toBeLessThanOrEqual(12);
    const provider: ProjectAiProvider = { id: "mock", generate: async () => ({ text: JSON.stringify({ diagram: architectureDiagram() }) }) };
    // The prompt keeps the full requirement while the package stores the bounded copy, so the two
    // must not have to be identical for generation to proceed.
    const result = await new ProjectAiGenerationService(provider).generateDiagram(input, { requirement, kind: "architecture" });
    expect(result.diagram.id).toBe("architecture");

    const missing = buildProjectEvidencePackage({ projectName: "Example", files });
    await expect(new ProjectAiGenerationService(provider).generateDiagram(missing, { requirement, kind: "architecture" }))
      .rejects.toMatchObject({ code: "invalid_output" });
  });

  it("updates a target diagram by stable id and version while rejecting kind/id changes", async () => {
    const requirement = "更新架构图";
    const input = evidence(requirement);
    const provider: ProjectAiProvider = { id: "mock", generate: async () => ({ text: JSON.stringify({ diagram: architectureDiagram() }) }) };
    const target = { id: "architecture", title: "Architecture", kind: "architecture" as const, version: 4 };
    const result = await new ProjectAiGenerationService(provider).generateDiagram(input, { requirement, kind: "architecture", target });
    expect(result.diagram.version).toBe(5);

    const changedId: ProjectAiProvider = { id: "mock", generate: async () => ({ text: JSON.stringify({ diagram: { ...architectureDiagram(), id: "other" } }) }) };
    await expect(new ProjectAiGenerationService(changedId).generateDiagram(input, { requirement, kind: "architecture", target })).rejects.toMatchObject({ code: "invalid_output" });

    const changedKind: ProjectAiProvider = { id: "mock", generate: async () => ({ text: JSON.stringify({ diagram: architectureDiagram() }) }) };
    await expect(new ProjectAiGenerationService(changedKind).generateDiagram(input, { requirement, kind: "workflow" })).rejects.toMatchObject({ code: "invalid_output" });

    await expect(new ProjectAiGenerationService(provider).generateDiagram(evidence(), { requirement }, {}))
      .rejects.toMatchObject({ code: "invalid_output" });
  });
});
