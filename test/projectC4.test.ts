import { describe, expect, it } from "vitest";
import { projectIntentSchema, validateProjectIntent } from "../src/features/project/contracts/projectIntent.js";
import { attachProjectStructure, buildProjectEvidencePackage, ProjectAiGenerationService, validateProjectAiModel } from "../src/features/project/host/generation/projectAiGeneration.js";
import { projectIndexQuality } from "../src/features/project/host/generation/projectIndexQuality.js";
import { buildProjectTopics, topicFingerprint } from "../src/features/project/knowledge/projectTopics.js";

import { buildStructureIndex } from "../src/features/project/host/indexing/projectStructure.js";

const evidence = [{ path: "README.md", line: 1 }];
const fixture = () => projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example", evidence },
  contexts: [{ id: "execution", canonicalName: "Execution", evidence }],
  c4: { systemId: "app", elements: [
    { id: "app", name: "Application", kind: "system", evidence },
    { id: "user", name: "Developer", kind: "person", evidence },
    { id: "api", name: "API", kind: "container", parentId: "app", contextIds: ["execution"], evidence },
    { id: "store", name: "Store", kind: "container", parentId: "app", evidence }
  ], relationships: [
    { id: "uses", from: "user", to: "app", description: "Uses application", evidence },
    { id: "invokes", from: "user", to: "api", description: "Submits a request", evidence },
    { id: "persists", from: "api", to: "store", description: "Persists jobs", evidence }
  ] }
});

describe("C4 project views", () => {
  it("reports missing knowledge links and isolated nodes without mistaking projected interactions for isolation", () => {
    const intent = fixture();
    intent.c4!.elements.push({ id: 'orphan', name: 'Orphan', kind: 'system', description: '', external: true, contextIds: [], evidence });
    intent.qualityIssues = projectIndexQuality(intent, []);
    expect(intent.qualityIssues.map(issue => [issue.code, issue.elementIds[0]])).toEqual([
      ['missing-context-mapping', 'store'], ['isolated-c4-element', 'orphan']
    ]);
    expect(buildProjectTopics(intent).find(topic => topic.kind === 'containers')?.qualityWarnings?.join(' ')).toContain('Store');
    expect(validateProjectIntent(intent)).toEqual([]);
  });
  it("projects container interactions to their owning systems without internal self-edges or lost evidence", () => {
    const intent = fixture();
    intent.c4!.elements.push({ id: 'tools', name: 'Tools', kind: 'system', external: true, description: '', contextIds: [], evidence });
    intent.c4!.relationships.push(
      { id: 'call-tools', from: 'api', to: 'tools', description: 'Call tools', technology: 'HTTP', evidence },
      { id: 'store-tools', from: 'store', to: 'tools', description: 'Upload artifacts', evidence: [{ path: 'src/store.ts', line: 4 }] },
      { id: 'callback', from: 'tools', to: 'api', description: 'Callback', evidence }
    );
    const before = JSON.stringify(intent);
    const [c1, c2] = buildProjectTopics(intent);
    expect(c1!.diagram!.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'app', to: 'tools', label: 'Call tools; Upload artifacts · HTTP', evidence: [...evidence, { path: 'src/store.ts', line: 4 }] }),
      expect.objectContaining({ from: 'tools', to: 'app' })
    ]));
    expect(c1!.diagram!.relations.some(edge => edge.from === edge.to)).toBe(false);
    expect(c1!.diagram!.relations.filter(edge => edge.from === 'user' && edge.to === 'app')).toHaveLength(1);
    expect(c2!.diagram!.relations.some(edge => edge.from === 'api' && edge.to === 'tools')).toBe(true);
    expect(JSON.stringify(intent)).toBe(before);
  });
  it("preserves old models without inventing containers from responsibilities", () => {
    const old = fixture(); delete old.c4;
    expect(buildProjectTopics(projectIntentSchema.parse(old)).map(topic => topic.kind)).toEqual(["context"]);
  });

  it("derives distinct levels with stable source and responsibility links", () => {
    const [context, containers] = buildProjectTopics(fixture());
    expect(context!.diagram!.nodes.map(node => node.id)).toEqual(["app", "user"]);
    expect(context!.diagram!.relations.map(edge => edge.id)).toEqual(["uses"]);
    expect(context!.diagram!.nodes[0]!.semanticIds).toContain(containers!.id);
    expect(containers!.diagram!.nodes.map(node => node.id)).toEqual(["api", "store", "user"]);
    expect(containers!.diagram!.relations.map(edge => edge.id)).toEqual(["invokes", "persists"]);
    expect(containers!.diagram!.semantics!.boundaries![0]!.nodeIds).toEqual(["api", "store"]);
    expect(containers!.sections![0]).toMatchObject({ id: "api", relatedTopicIds: ["execution"], evidence });
    const changed = fixture(); changed.c4!.elements[2]!.technology = "Node.js";
    expect(topicFingerprint(buildProjectTopics(changed)[1]!)).not.toBe(topicFingerprint(containers!));
  });

  it("rejects missing parents, broken links, duplicate IDs and mixed system/container edges", () => {
    const model = fixture();
    model.c4!.elements[2]!.parentId = "execution";
    model.c4!.elements[2]!.contextIds = ["missing"];
    model.c4!.relationships[0]!.to = "store";
    model.c4!.relationships[0]!.from = "app";
    model.c4!.elements[3]!.id = "execution";
    expect(validateProjectIntent(model).map(error => error.message).join(" ")).toMatch(/Duplicate intent id/);
    expect(validateProjectIntent(model).map(error => error.message).join(" ")).toMatch(/must belong/);
    expect(validateProjectIntent(model).map(error => error.message).join(" ")).toMatch(/missing intent id/);
    const mixed = fixture(); mixed.c4!.relationships[0]!.from = "app"; mixed.c4!.relationships[0]!.to = "api";
    expect(validateProjectIntent(mixed).some(error => /must not mix/.test(error.message))).toBe(true);
    mixed.c4!.elements[0]!.external = true;
    expect(validateProjectIntent(mixed).some(error => error.path === "c4.systemId")).toBe(true);
  });

  it("requires read excerpts and stamps C4 evidence through the current index generator", async () => {
    const input = buildProjectEvidencePackage({ files: [{ path: "README.md", content: "Application: developer -> API -> store." }] });
    const model = { intent: fixture(), diagrams: [] };
    expect(validateProjectAiModel(model, input)).toEqual([]);
    const structure = await buildStructureIndex([{ path: "src/app.ts", content: "export function start() {}" }]);
    const c4 = fixture().c4!;
    c4.elements.forEach(element => { element.contextIds = []; });
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async request => ({ text: JSON.stringify(
      request.prompt.includes("Optionally describe C4")
        ? { brief: { name: "Example", summary: "Application", evidence }, capabilities: [{ canonicalName: "Application", description: "Runs the app", contextIds: [...new Set(request.prompt.match(/responsibility:[a-f0-9]+/g) ?? [])] }], c4 }
        : { contexts: [{ canonicalName: "Application", purpose: "Runs the app", sourceFiles: ["src/app.ts"], entryPoints: ["src/app.ts"] }] }
    ) }) }, { maxAttempts: 1 });
    const generated = await service.generateIndex(attachProjectStructure(input, structure.summary));
    expect(generated.intent.c4!.elements[0]!.evidence[0]!.contentHash).toBe(input.files[0]!.contentHash);
    expect(generated.intent.c4!.relationships[0]!.evidence[0]!.contentHash).toBe(input.files[0]!.contentHash);
    const inventoryOnly = { ...input, files: [] };
    expect(validateProjectAiModel(model, inventoryOnly).some(error => error.includes("require a read excerpt"))).toBe(true);
    expect(projectIntentSchema.parse(model.intent).c4!.systemId).toBe("app");
  });
});
