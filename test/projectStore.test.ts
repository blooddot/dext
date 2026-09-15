import { describe, expect, it } from "vitest";
import { ProjectStore, defaultProjectDefinition, projectDiagramPath, type ProjectFileHost } from "../src/projectStore.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";
import { projectObjectSchema } from "../src/core/projectKnowledge.js";

class MemoryHost implements ProjectFileHost {
  readonly files = new Map<string, string>();
  async readFile(path: string): Promise<string | undefined> { return this.files.get(path); }
  async writeFile(path: string, content: string): Promise<void> { this.files.set(path, content); }
  async deleteFile(path: string): Promise<void> { this.files.delete(path); }
  async listDirectory(dir: string): Promise<string[]> {
    const prefix = `${dir}/`;
    return [...this.files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
  }
}

const object = (id: string, canonicalName: string) => projectObjectSchema.parse({
  id, canonicalName, kind: "module", source: "user", confirmation: "accepted"
});

const diagram = (id = "architecture"): ProjectDiagram => ({
  schemaVersion: 1,
  id,
  title: "Architecture",
  kind: "architecture",
  version: 1,
  updatedAt: 42,
  nodes: [
    { id: "app", label: "App", role: "module", semanticIds: [], evidence: [] },
    { id: "db", label: "Database", role: "store", semanticIds: [], evidence: [] }
  ],
  relations: [{ id: "app-db", from: "app", to: "db", kind: "writes", evidence: [] }]
});

describe("project store", () => {
  it("saves project definitions and reports concurrent edits as conflicts", async () => {
    const store = new ProjectStore(new MemoryHost());
    const initial = await store.readDefinition();
    const first = await store.writeDefinition({ ...initial, preset: { default: "experience" } }, initial.version);
    expect(first.status).toBe("applied");
    // A second writer that still holds the old version must not clobber the newer value.
    const stale = await store.writeDefinition({ ...initial, preset: { default: "engineering" } }, initial.version);
    expect(stale.status).toBe("conflict");
    if (stale.status === "conflict") expect(stale.current.preset.default).toBe("experience");
    expect((await store.readDefinition()).preset.default).toBe("experience");
  });

  it("starts from project defaults when no file exists", async () => {
    const store = new ProjectStore(new MemoryHost());
    expect(await store.readDefinition()).toMatchObject({
      schemaVersion: 1, version: 0, preset: { default: "engineering" }, knowledge: { enabled: false, initialized: false }
    });
    expect(await store.readPresetDefault()).toBe("engineering");
  });

  it("caches the preset default so a send can freeze it synchronously", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    // Before the first read the built-in default applies.
    expect(store.presetDefault()).toBe("engineering");
    await store.writeDefinition({ ...defaultProjectDefinition(), preset: { default: "experience" } }, 0);
    expect((await store.readDefinition()).preset.default).toBe("experience");
    expect(store.presetDefault()).toBe("experience");
  });

  it("keeps accepted objects when conversation run records are cleaned up", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    await store.writeObject(object("one", "TaskQuery"));
    await store.writeObject(object("two", "TaskStats"));
    // Simulate conversation snapshots living in the workspace cache, then being cleared.
    host.files.set(".dext/cache/runs/s1/t1.json", "{}");
    host.files.set(".dext/cache/runs/s2/t1.json", "{}");
    for (const path of [...host.files.keys()].filter((item) => item.startsWith(".dext/cache/runs/"))) host.files.delete(path);
    const objects = await store.readObjects();
    expect(objects.map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("persists generated diagrams under .dext/diagrams and reloads them", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    const generated = diagram("architecture/v1");

    await store.writeDiagram(generated);

    expect(host.files.has(projectDiagramPath(generated.id))).toBe(true);
    expect(await store.readDiagrams()).toEqual([generated]);
  });

  it("rejects invalid diagrams and ignores damaged files without hiding valid ones", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    await store.writeDiagram(diagram("valid"));
    host.files.set(".dext/diagrams/damaged.json", "{not json");
    host.files.set(".dext/diagrams/dangling.json", JSON.stringify({
      ...diagram("dangling"),
      relations: [{ id: "bad", from: "missing", to: "app", kind: "writes", evidence: [] }]
    }));

    await expect(store.writeDiagram({ ...diagram("invalid"), relations: [{ id: "bad", from: "missing", to: "app", kind: "writes", evidence: [] }] })).rejects.toThrow("Invalid project diagram");
    expect((await store.readDiagrams()).map((item) => item.id)).toEqual(["valid"]);
  });
});
