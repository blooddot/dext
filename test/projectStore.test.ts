import { describe, expect, it } from "vitest";
import { ProjectStore, defaultProjectDefinition, projectDiagramPath, PROJECT_ARCHITECTURE_PATH, type ProjectFileHost } from "../src/projectStore.js";
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
  it("round-trips the evidence record and tolerates a damaged one", async () => {
    const host = new MemoryHost();
    const store = new ProjectStore(host);
    const summary = {
      version: 1 as const, trigger: "diagram" as const, generatedAt: 5, inputHash: "hash",
      selection: { scope: ["src/**"], preset: "deep", files: 800, fileChars: 20_000, evidenceChars: 900_000 },
      inventory: { total: 10, withSymbols: 7, byKind: { source: 10 } },
      excerpts: { total: 4, truncated: 1, byKind: { source: 4 } },
      omitted: { files: 6, objects: 0, knowledge: 0 },
      coverage: ["Source text exceeds the limit."],
      paths: ["src/app.ts"],
      excerpted: ["src/app.ts"]
    };
    expect(await store.readEvidenceSummary()).toBeUndefined();
    await store.writeEvidenceSummary(summary);
    expect(await store.readEvidenceSummary()).toEqual(summary);

    // A damaged or future-schema record is ignored instead of blocking the page.
    host.files.set(".dext/evidence.json", "{ not json");
    expect(await store.readEvidenceSummary()).toBeUndefined();
    host.files.set(".dext/evidence.json", JSON.stringify({ version: 2, trigger: "diagram" }));
    expect(await store.readEvidenceSummary()).toBeUndefined();
  });

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

describe("legacy project data and initialization recovery", () => {
  it("loads legacy scan and engine fields without rewriting or deleting them", async () => {
    const host = new MemoryHost();
    host.files.set(".dext/project.json", JSON.stringify({
      schemaVersion: 1,
      version: 3,
      preset: { default: "experience" },
      knowledge: { enabled: true, initialized: true },
      ai: { cli: "codex" },
      scan: { roots: ["src"], includeTests: true, extraExcludes: ["vendor"] },
      diagramAdapters: { byKind: { architecture: "drawio" }, byDiagram: { legacy: "mermaid" } },
      updatedAt: 1
    }));
    const store = new ProjectStore(host);
    const definition = await store.readDefinition();
    expect(definition.preset.default).toBe("experience");
    expect((definition as Record<string, unknown>).scan).toEqual({ roots: ["src"], includeTests: true, extraExcludes: ["vendor"] });

    const before = host.files.get(".dext/project.json");
    await store.readDefinition();
    await store.readInitialization();
    await store.readDiagrams();
    expect(host.files.get(".dext/project.json")).toBe(before);

    const saved = await store.writeDefinition({ ...definition, preset: { default: "engineering" } }, definition.version);
    expect(saved.status).toBe("applied");
    const written = JSON.parse(host.files.get(".dext/project.json")!) as Record<string, unknown>;
    expect(written["preset"]).toEqual({ default: "engineering" });
    expect(written["scan"]).toEqual({ roots: ["src"], includeTests: true, extraExcludes: ["vendor"] });
    expect(written["diagramAdapters"]).toEqual({ byKind: { architecture: "drawio" }, byDiagram: { legacy: "mermaid" } });
  });

  it("requires a valid saved intent for initialization recovery", async () => {
    const host = new MemoryHost();
    host.files.set(".dext/project.json", JSON.stringify({ ...defaultProjectDefinition(1), knowledge: { enabled: true, initialized: true } }));
    await new ProjectStore(host).writeDiagram(diagram("arch"));
    const store = new ProjectStore(host);
    expect(await store.readInitialization()).toEqual({ markedInitialized: true, hasIntent: false, diagramCount: 1 });
    await store.writeIntent({
      schemaVersion: 1,
      brief: { name: "Example", summary: "Summary", evidence: [] },
      updatedAt: 1
    } as never);
    expect(await store.readInitialization()).toMatchObject({ hasIntent: true, diagramCount: 1 });
  });

  it("reads and writes declared architecture rules with their diagram", async () => {
    const host = new MemoryHost();
    host.files.set(PROJECT_ARCHITECTURE_PATH, JSON.stringify({
      schemaVersion: 1, version: 2, updatedAt: 5,
      decisions: [{ id: "d1", title: "Use queues", detail: "Async by default." }],
      diagramId: "arch",
      rules: [
        { id: "no-ui-db", type: "deny", from: "ui", to: "db", reason: "UI writes through the API." },
        { id: "acyclic", type: "no_cycles", from: "*" }
      ]
    }));
    const store = new ProjectStore(host);
    const architecture = await store.readArchitecture();
    expect(architecture.diagramId).toBe("arch");
    expect(architecture.rules).toHaveLength(2);
    expect(architecture.decisions).toHaveLength(1);

    const saved = await store.writeArchitecture({ ...architecture, decisions: [...architecture.decisions, { id: "d2", title: "Second", detail: "" }] }, architecture.version);
    expect(saved.status).toBe("applied");
    const written = JSON.parse(host.files.get(PROJECT_ARCHITECTURE_PATH)!) as { rules: unknown[]; diagramId: string; version: number };
    expect(written.rules).toHaveLength(2);
    expect(written.diagramId).toBe("arch");
    expect(written.version).toBe(3);
  });

  it("falls back to defaults when the rules file is damaged instead of leaking a partial document", async () => {
    const host = new MemoryHost();
    // A typo in a rule type must not be silently accepted.
    host.files.set(PROJECT_ARCHITECTURE_PATH, JSON.stringify({ schemaVersion: 1, version: 1, updatedAt: 0, decisions: [], rules: [{ id: "r", type: "forbid", from: "a" }] }));
    const architecture = await new ProjectStore(host).readArchitecture();
    expect(architecture.rules).toEqual([]);
    expect(architecture.version).toBe(0);
  });
});
