import { describe, expect, it, vi } from "vitest";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";
import { bootstrapProject, detectProjectBootstrap, readBootstrapCheckpoint } from "../src/features/project/host/projectBootstrap.js";
import { ProjectStore, type ProjectFileHost } from "../src/features/project/host/persistence/projectStore.js";

function fixture(entries: Array<[string, string]> = []) {
  const files = new Map(entries);
  const host: ProjectFileHost = { readFile: async path => files.get(path), writeFile: async (path, text) => { files.set(path, text); }, listDirectory: async dir => [...files.keys()].filter(path => path.startsWith(dir + "/")).map(path => path.slice(dir.length + 1)) };
  const store = new ProjectStore(host);
  return { files, host, store, options: { name: "Demo", host, store, paths: entries.map(([path]) => path), ai: "test", signal: new AbortController().signal, progress: () => {} } };
}
describe("native Project bootstrap", () => {
  it("selects routes from actual artifacts and does not treat plans as durable norms", () => {
    expect(detectProjectBootstrap({ legacy: true, paths: [] })).toBe("legacy");
    expect(detectProjectBootstrap({ legacy: false, paths: ["docs/contracts/api.md"] })).toBe("documents");
    expect(detectProjectBootstrap({ legacy: false, paths: ["src/a.ts"] })).toBe("code");
    expect(detectProjectBootstrap({ legacy: false, paths: ["docs/plans/design.plan.md", "README.md"] })).toBe("empty");
  });
  it("initializes an empty project without a parser or AI and adopts documents in place", async () => {
    const empty = fixture(); const initialized = await bootstrapProject(empty.options);
    expect(initialized.model?.nodes[0]?.review).toBe("draft");
    expect(detectProjectBootstrap({ model: initialized.model!, legacy: false, paths: [] })).toBe("existing");
    const docs = fixture([["docs/contracts/api.md", "# API contract"]]);
    const adopted = await bootstrapProject(docs.options);
    expect(adopted.model?.nodes[1]?.body).toMatchObject({ kind: "document", path: "docs/contracts/api.md" });
    expect(docs.files.get("docs/contracts/api.md")).toBe("# API contract");
    expect([...docs.files.keys()].some(path => path.startsWith(".dext/project/knowledge/"))).toBe(false);
  });
  it("does not commit after cancellation or source drift", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const controller = new AbortController(); controller.abort();
    await expect(bootstrapProject({ ...f.options, signal: controller.signal })).rejects.toThrow();
    expect(f.files.has(".dext/project/model.json")).toBe(false);
  });
  it("resumes a saved candidate without calling AI twice and invalidates changed sources", async () => {
    const f = fixture([["src/app.ts", "export const a = 1"]]);
    const candidate = projectModelSchema.parse({ schemaVersion: 1, revision: 0, updatedAt: 0, nodes: [{ id: "api", kind: "contract", title: "API", canonicalName: "API", body: { kind: "inline", text: "Contract" } }], relations: [] });
    const generate = vi.fn(async () => ({ text: JSON.stringify(candidate) }));
    const save = f.host.writeFile.bind(f.host);
    f.host.writeFile = async (path, content) => { if (path.endsWith("model.json")) throw new Error("Interrupted commit"); await save(path, content); };
    await expect(bootstrapProject({ ...f.options, provider: { id: "fixture", generate } })).rejects.toThrow("Interrupted");
    expect(await readBootstrapCheckpoint(f.host)).toMatchObject({ stage: "code:candidate" });
    f.host.writeFile = save;
    await bootstrapProject({ ...f.options, provider: { id: "fixture", generate } });
    expect(generate).toHaveBeenCalledOnce(); expect(await readBootstrapCheckpoint(f.host)).toBeUndefined();
    const drift = fixture([["src/app.ts", "before"]]);
    await expect(bootstrapProject({ ...drift.options, provider: { id: "fixture", generate: async () => { drift.files.set("src/app.ts", "during generation"); return { text: JSON.stringify(candidate) }; } } })).rejects.toThrow("source changed");
    expect(drift.files.has(".dext/project/model.json")).toBe(false);
  });
});
