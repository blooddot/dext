import { describe, expect, it } from "vitest";
import { buildProjectEvidencePackage, ProjectAiGenerationService, type ProjectAiRequest } from "../src/features/project/host/generation/projectAiGeneration.js";
import { buildProjectTopics } from "../src/features/project/knowledge/projectTopics.js";
import { projectIntentSchema } from "../src/features/project/contracts/projectIntent.js";
import type { ProjectDiagram } from "../src/features/project/contracts/projectDiagram.js";

const evidence = [{ path: "src/code.ts", line: 1 }];
const index = { brief: { name: "Example", summary: "Runs code", evidence }, contexts: [{ id: "code", canonicalName: "Execution", purpose: "Runs code", entryPoints: ["src/code.ts"], evidence }] };
const input = () => buildProjectEvidencePackage({ files: [{ path: "src/code.ts", content: "export function execute() {}" }] });

describe("Project model and module analyses", () => {
  it("generates only an index with a small schema and no phantom diagram", async () => {
    let request: ProjectAiRequest | undefined;
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async value => { request = value; return { text: JSON.stringify(index) }; } }, { maxAttempts: 1 });
    const result = await service.generateProjectModelFromExcerpts(input());
    expect(result.diagrams).toEqual([]);
    expect(result.intent.contexts[0]).toMatchObject({ detail: "outline", entryPoints: ["src/code.ts"] });
    expect(result.intent.contexts[0]!.evidence[0]!.contentHash).toBe(input().files[0]!.contentHash);
    expect(result.intent.flows).toEqual([]);
    expect(result.intent.c4).toBeUndefined();
    expect(JSON.stringify(request!.responseSchema)).not.toMatch(/diagram|symbol|steps/);
    const topic = buildProjectTopics(result.intent)[0]!;
    expect(topic.analysisState).toBe("outline");
    expect(topic.diagram).toBeUndefined();
  });

  it("rejects missing entry paths and an oversized full-project answer", async () => {
    const service = (value: unknown) => new ProjectAiGenerationService({ id: "fixture", generate: async () => ({ text: JSON.stringify(value) }) }, { maxAttempts: 1 });
    await expect(service({ ...index, contexts: [{ ...index.contexts[0], entryPoints: ["src/missing.ts"] }] }).generateProjectModelFromExcerpts(input())).rejects.toMatchObject({ diagnostics: expect.arrayContaining([expect.stringContaining("Entry point")]) });
    await expect(service({ ...index, diagrams: [] }).generateProjectModelFromExcerpts(input())).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("keeps explanation, node descriptions and evidence in the same saved result, and detects changed outlines", () => {
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, ...index, contexts: index.contexts.map(context => ({ ...context, detail: "outline" })) });
    const basis = buildProjectTopics(intent)[0]!.basis!;
    const diagram: ProjectDiagram = { schemaVersion: 1, id: "detail", title: "Execution", kind: "architecture", version: 1, updatedAt: 2,
      metadata: { topicId: "code", topicAnalysis: 1, topicBasis: basis, topicSummary: "Executes a module and returns its result." },
      nodes: [{ id: "execute", label: "Execute", description: "Runs the module exports.", role: "component", semanticIds: ["code"], evidence }], relations: [] };
    const topic = buildProjectTopics(intent, [diagram])[0]!;
    expect(topic).toMatchObject({ analysisState: "ready", description: "Executes a module and returns its result.", sections: [{ id: "execute", description: "Runs the module exports.", evidence }] });
    expect(topic.diagram).toBe(diagram);
    intent.contexts[0]!.purpose = "Changed responsibility";
    expect(buildProjectTopics(intent, [diagram])[0]).toMatchObject({ analysisState: "stale", diagram });
  });

  it("rejects a topic diagram that has no matching explanation", async () => {
    const packaged = buildProjectEvidencePackage({ files: [{ path: "src/code.ts", content: "export function execute() {}" }], requirement: "Explain execution" });
    const diagram = { schemaVersion: 1, id: "detail", title: "Execution", kind: "architecture", nodes: [{ id: "execute", label: "Execute", role: "component", semanticIds: [], evidence }], relations: [] };
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async () => ({ text: JSON.stringify({ diagram }) }) }, { maxAttempts: 1 });
    await expect(service.generateDiagram(packaged, { requirement: "Explain execution", explainTopic: true })).rejects.toMatchObject({ diagnostics: expect.arrayContaining([expect.stringContaining("explanatory description")]) });
  });
});
