import { describe, expect, it } from "vitest";
import { buildProjectEvidencePackage, ProjectAiGenerationService } from "../src/features/project/host/generation/projectAiGeneration.js";
import { buildProjectTopics } from "../src/features/project/knowledge/projectTopics.js";
import { projectIntentSchema } from "../src/features/project/contracts/projectIntent.js";
import type { ProjectDiagram } from "../src/features/project/contracts/projectDiagram.js";

const evidence = [{ path: "src/code.ts", line: 1 }];
const index = { brief: { name: "Example", summary: "Runs code", evidence }, contexts: [{ id: "code", canonicalName: "Execution", purpose: "Runs code", entryPoints: ["src/code.ts"], evidence }] };

describe("Project model and module analyses", () => {
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
