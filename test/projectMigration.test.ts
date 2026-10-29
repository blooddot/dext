import { describe, expect, it } from "vitest";
import { ProjectStore, type ProjectFileHost } from "../src/features/project/host/persistence/projectStore.js";
import { commitProjectMigration, migrateProjectModel } from "../src/features/project/host/persistence/projectMigration.js";
import { projectContentHash } from "../src/features/project/host/persistence/projectHash.js";
import { projectModelRelationSchema } from "../src/features/project/contracts/projectModel.js";

function fixture() {
  const files = new Map<string, string>([
    [".dext/objects/api.json", JSON.stringify({ id: "api", canonicalName: "Api", kind: "module", source: "user", confirmation: "accepted", description: "User-owned contract" })],
    [".dext/project-intent.json", JSON.stringify({ schemaVersion: 1, brief: { name: "App" }, contexts: [{ id: "api", canonicalName: "Api", purpose: "Context purpose", review: "accepted" }], updatedAt: 0 })]
  ]);
  const host: ProjectFileHost = { readFile: async path => files.get(path), writeFile: async (path, text) => { files.set(path, text); }, listDirectory: async dir => [...files.keys()].filter(path => path.startsWith(dir + "/")).map(path => path.slice(dir.length + 1)) };
  return { host, files, store: new ProjectStore(host) };
}
describe("Project format migration", () => {
  it("migrates architecture endpoints into explicit relationships and retains the saved diagram", async () => {
    const f = fixture();
    const diagram = { schemaVersion: 1, id: "arch", title: "Architecture", kind: "architecture", version: 1, updatedAt: 0,
      nodes: ["api", "db"].map(id => ({ id, label: id, role: "module", semanticIds: [], evidence: [] })), relations: [] };
    f.files.set(".dext/diagrams/arch.json", JSON.stringify(diagram));
    f.files.set(".dext/architecture.json", JSON.stringify({ schemaVersion: 1, version: 1, diagramId: "arch", decisions: [{ id: "choice", title: "Storage", detail: "Keep storage behind API" }], rules: [{ id: "boundary", type: "deny", from: "api", to: "db", reason: "Use adapter" }], updatedAt: 0 }));
    const model = await commitProjectMigration(f.host, await f.store.readLegacySnapshot());
    expect(model.relations.filter(edge => edge.from === "boundary")).toHaveLength(2);
    expect((await f.store.readArchitecture()).rules).toMatchObject([{ id: "boundary", from: "api", to: "db", type: "deny" }]);
    expect(await f.store.readDiagrams()).toMatchObject([diagram]);
    await expect(f.store.writeArchitecture(await f.store.readArchitecture(), model.revision)).rejects.toThrow("authoritative");
    f.files.set(".dext/architecture.json", "obsolete broken data");
    expect((await f.store.readArchitecture()).decisions[0]?.detail).toBe("Keep storage behind API");
  });
  it("uses deterministic aliases and backs up exact bytes before committing", async () => {
    const f = fixture(); const snapshot = await f.store.readLegacySnapshot();
    const first = migrateProjectModel(snapshot); expect(migrateProjectModel(snapshot)).toEqual(first);
    expect(first.nodes.find(node => node.kind === "module")?.id).toBe("api");
    expect(first.nodes.find(node => node.kind === "context")?.id).toMatch(/^api~/);
    const model = await commitProjectMigration(f.host, snapshot);
    expect(JSON.parse(f.files.get(model.migration!.backup)!)).toMatchObject({ files: snapshot.files });
    expect(await commitProjectMigration(f.host, snapshot)).toEqual(model);
    await expect(f.store.writeIntent(snapshot.intent!)).rejects.toThrow("authoritative");
  });
  it("keeps a legacy context named project distinct from the synthetic brief", async () => {
    const f = fixture();
    f.files.set(".dext/objects/api.json", JSON.stringify({ id: "project", kind: "module", canonicalName: "Project", source: "user" }));
    f.files.set(".dext/project-intent.json", JSON.stringify({ schemaVersion: 1, brief: { name: "App" }, contexts: [{ id: "project", canonicalName: "Project", purpose: "Context" }], updatedAt: 0 }));
    const model = migrateProjectModel(await f.store.readLegacySnapshot());
    expect(new Set(model.nodes.map(node => node.id)).size).toBe(3);
    expect(model.migration?.aliases["brief:project"]).not.toBe(model.migration?.aliases["intent:project"]);
  });
  it("checks the entire source baseline before switching formats", async () => {
    const f = fixture(); const snapshot = await f.store.readLegacySnapshot();
    f.files.set(".dext/objects/api.json", "external change");
    await expect(commitProjectMigration(f.host, snapshot)).rejects.toThrow("changed");
    expect(f.files.has(".dext/project/model.json")).toBe(false);
  });
  it("protects revisions, incoming edges and adopted document hashes", async () => {
    const f = fixture(); const model = await commitProjectMigration(f.host, await f.store.readLegacySnapshot());
    await expect(f.store.updateProject(model, model.revision + 1)).rejects.toThrow("revision conflict");
    const document = { path: "docs/contract.md", beforeHash: null, content: "Normative body" };
    const next = { ...model, nodes: model.nodes.map((node, index) => index === 0 ? { ...node, body: { kind: "document" as const, path: document.path, contentHash: projectContentHash(document.content) } } : node) };
    const saved = await f.store.updateProject(next, model.revision, [document]);
    expect(f.files.get(document.path)).toBe(document.content); expect(saved.revision).toBe(model.revision + 1);
    f.files.set(document.path, "external");
    await expect(f.store.updateProject(saved, saved.revision, [document])).rejects.toThrow("document conflict");
    const edge = projectModelRelationSchema.parse({ id: "edge", kind: "related_to", from: saved.nodes[0]!.id, to: saved.nodes[1]!.id });
    const related = await f.store.updateProject({ ...saved, relations: [edge] }, saved.revision);
    await expect(f.store.updateProject({ ...related, nodes: related.nodes.slice(1) }, related.revision)).rejects.toThrow("Dangling");
    const removed = await f.store.updateProject({ ...related, nodes: related.nodes.slice(1), relations: [] }, related.revision);
    expect(removed.relations).toEqual([]);
  });
  it("detects newly added legacy files and retains a recovery journal for interrupted document commits", async () => {
    const f = fixture(); const snapshot = await f.store.readLegacySnapshot();
    f.files.set(".dext/objects/new.json", JSON.stringify({ id: "new", kind: "module", canonicalName: "New", source: "user" }));
    await expect(commitProjectMigration(f.host, snapshot)).rejects.toThrow("file set changed");
    const model = await commitProjectMigration(f.host, await f.store.readLegacySnapshot());
    const documents = ["docs/a.md", "docs/b.md"].map(path => ({ path, beforeHash: null, content: path }));
    const next = { ...model, nodes: model.nodes.map((node, i) => i < 2 ? { ...node, body: { kind: "document" as const, path: documents[i]!.path, contentHash: projectContentHash(documents[i]!.content) } } : node) };
    const save = f.host.writeFile.bind(f.host);
    f.host.writeFile = async (path, value) => { if (path === "docs/b.md") throw new Error("interrupted"); await save(path, value); };
    await expect(f.store.updateProject(next, model.revision, documents)).rejects.toThrow("interrupted");
    expect((await f.store.readModel())?.revision).toBe(model.revision);
    expect([...f.files.keys()].some(path => path.includes("/update-"))).toBe(true);
    f.host.writeFile = save;
    await f.store.updateProject(next, model.revision, documents);
    expect((await f.store.readModel())?.revision).toBe(model.revision + 1);
  });
});
