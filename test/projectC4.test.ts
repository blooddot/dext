import { describe, expect, it } from "vitest";
import { parseProjectIntent, projectIntentSchema, validateProjectIntent } from "../src/core/projectIntent.js";
import { buildProjectTopics, topicFingerprint } from "../src/core/projectTopics.js";
import { projectIndexQuality } from "../src/core/projectIndexQuality.js";
import { buildProjectEvidencePackage, ProjectAiGenerationService, validateProjectAiModel } from "../src/core/projectAiGeneration.js";

const evidence = [{ path: "README.md", line: 1 }];
const fixture = () => parseProjectIntent({ schemaVersion: 1, updatedAt: 1, brief: { name: "Example", evidence },
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
    expect(buildProjectTopics(parseProjectIntent(old)).map(topic => topic.kind)).toEqual(["context"]);
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
    expect(() => parseProjectIntent(mixed)).toThrow(/must not mix/);
    mixed.c4!.elements[0]!.external = true;
    expect(validateProjectIntent(mixed).some(error => error.path === "c4.systemId")).toBe(true);
  });

  it("requires read excerpts and stamps C4 evidence during generation", async () => {
    const input = buildProjectEvidencePackage({ files: [{ path: "README.md", content: "Application: developer -> API -> store." }] });
    const model = { intent: fixture(), diagrams: [] };
    expect(validateProjectAiModel(model, input)).toEqual([]);
    const service = new ProjectAiGenerationService({ id: "fixture", generate: async () => ({ text: JSON.stringify(model) }) }, { maxAttempts: 1 });
    const generated = await service.generate(input);
    expect(generated.intent.c4!.elements[0]!.evidence[0]!.contentHash).toBe(input.files[0]!.contentHash);
    expect(generated.intent.c4!.relationships[0]!.evidence[0]!.contentHash).toBe(input.files[0]!.contentHash);
    const inventoryOnly = { ...input, files: [] };
    expect(validateProjectAiModel(model, inventoryOnly).some(error => error.includes("require a read excerpt"))).toBe(true);
    expect(projectIntentSchema.parse(model.intent).c4!.systemId).toBe("app");
  });
});
