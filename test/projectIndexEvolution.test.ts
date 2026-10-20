import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { ProjectStore } from "../src/features/project/host/persistence/projectStore.js";
import { describe, expect, it } from "vitest";
import type { ProjectDiagram } from "../src/features/project/contracts/projectDiagram.js";
import { projectIntentSchema, validateProjectIntent } from "../src/features/project/contracts/projectIntent.js";
import { analysisSourceFiles, reconcileProjectIndex } from "../src/features/project/knowledge/projectIndexEvolution.js";
import { buildProjectTopics } from "../src/features/project/knowledge/projectTopics.js";
import { readerGalleryArticle, renderProjectTopics } from "../src/features/project/presentation/projectTopicsView.js";

const intent = (contexts: { id: string; sourceFiles: string[]; dependsOn?: string[] }[]) => projectIntentSchema.parse({
  schemaVersion: 1, updatedAt: 1, brief: { name: "App" },
  contexts: contexts.map(context => ({ canonicalName: context.id, purpose: 'Describe this feature', detail: 'outline', entryPoints: context.sourceFiles, ...context }))
});
const analysis = (topicId: string, sourceFiles: string[]): ProjectDiagram => ({ schemaVersion: 1, id: 'saved-analysis', title: 'Saved execution', kind: 'architecture', version: 1, updatedAt: 1,
  nodes: [], relations: [], metadata: { topicId, topicAnalysis: 1, topicSummary: 'Historical behavior',
    topicBasis: JSON.stringify([topicId, 'Old purpose', sourceFiles, [], 'old-hash', [], sourceFiles]) }
});

describe('Project index continuity', () => {
  it('preserves unambiguous module identities and remaps all generated references', () => {
    const previous = intent([{ id: 'old-a', sourceFiles: ['src/a.ts', 'src/aView.ts'] }, { id: 'old-b', sourceFiles: ['src/b.ts'] }]);
    const next = intent([{ id: 'new-a', sourceFiles: ['src/a.ts', 'src/aView.ts', 'src/aHelper.ts'], dependsOn: ['new-b'] }, { id: 'new-b', sourceFiles: ['src/b.ts'] }]);
    next.capabilities = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 1, brief: { name: 'App' }, capabilities: [{ id: 'area', canonicalName: 'Feature', contextIds: ['new-a', 'new-b'] }] }).capabilities;
    next.c4 = { systemId: 'app', elements: [{ id: 'app', name: 'App', description: '', kind: 'system', external: false, contextIds: ['new-a'], evidence: [] }], relationships: [] };
    next.qualityIssues = [{ code: 'ownership-review', message: 'Review helper ownership', contextIds: ['new-a', 'new-b'], elementIds: [], sourcePaths: ['src/aHelper.ts'] }];
    const before = JSON.stringify({ previous, next });
    const result = reconcileProjectIndex(next, previous, []);
    expect(result.contexts.map(context => context.id)).toEqual(['old-a', 'old-b']);
    expect(result.contexts[0]!.dependsOn).toEqual(['old-b']);
    expect(result.capabilities[0]!.contextIds).toEqual(['old-a', 'old-b']);
    expect(result.c4!.elements[0]!.contextIds).toEqual(['old-a']);
    expect(result.qualityIssues![0]!.contextIds).toEqual(['old-a', 'old-b']);
    expect(validateProjectIntent(result)).toEqual([]);
    expect(JSON.stringify({ previous, next })).toBe(before);
  });

  it('keeps changed continuations stale and never claims their previous analysis is current', () => {
    const previous = intent([{ id: 'old', sourceFiles: ['src/a.ts'] }]);
    const diagram = analysis('old', ['src/a.ts']);
    const next = reconcileProjectIndex(intent([{ id: 'new', sourceFiles: ['src/a.ts'] }]), previous, [diagram]);
    expect(buildProjectTopics(next, [diagram])[0]).toMatchObject({ id: 'old', analysisState: 'stale', diagram });
  });

  it('links split and merged histories without promoting the old whole-module graph', () => {
    const previous = intent([{ id: 'whole', sourceFiles: ['src/a.ts', 'src/b.ts'] }]);
    const diagram = analysis('whole', ['src/a.ts', 'src/b.ts']);
    const split = reconcileProjectIndex(intent([{ id: 'part-a', sourceFiles: ['src/a.ts'] }, { id: 'part-b', sourceFiles: ['src/b.ts'] }]), previous, [diagram]);
    expect(split.contexts.map(context => context.id)).toEqual(['part-a', 'part-b']);
    expect(split.contexts.every(context => context.previousContextIds?.includes('whole'))).toBe(true);
    const topics = buildProjectTopics(split, [diagram]);
    expect(topics.every(topic => topic.analysisState === 'outline' && !topic.diagram && topic.previousAnalyses?.[0]?.id === diagram.id)).toBe(true);
    expect(renderProjectTopics(topics, [], { diagrams: [diagram] })).toContain('Earlier module analyses');
    expect(readerGalleryArticle(diagram, { topics, checks: [], diagrams: [diagram], brief: '', gallery: true })).toContain('Module boundaries changed');
    const merged = reconcileProjectIndex(intent([{ id: 'merged', sourceFiles: ['src/a.ts', 'src/b.ts'] }]), split, [diagram]);
    expect(merged.contexts[0]).toMatchObject({ id: 'merged', previousContextIds: ['part-a', 'part-b', 'whole'] });
  });

  it('recovers already orphaned analyses using their saved membership, not titles or node evidence', () => {
    const current = intent([{ id: 'new', sourceFiles: ['src/a.ts'] }, { id: 'unrelated', sourceFiles: ['src/other.ts'] }]);
    const diagram = analysis('removed-id', ['src/a.ts', 'src/b.ts']);
    const topics = buildProjectTopics(current, [diagram]);
    expect(topics[0]!.previousAnalyses).toEqual([{ id: diagram.id, title: diagram.title }]);
    expect(topics[1]!.previousAnalyses).toBeUndefined();
    expect(reconcileProjectIndex(current, undefined, [diagram]).contexts[0]!.previousContextIds).toEqual(['removed-id']);
    expect(analysisSourceFiles({ ...diagram, metadata: { ...diagram.metadata, topicBasis: 'broken' } })).toEqual([]);
    expect(analysisSourceFiles({ ...diagram, metadata: { ...diagram.metadata, topicId: 'foreign' } })).toEqual([]);
  });
});

it("keeps old diagrams readable in a temporary workspace after a path-only migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dext-history-migration-"));
  const target = (path: string) => {
    const value = resolve(directory, path);
    if (!value.startsWith(resolve(directory) + (process.platform === "win32" ? "\\" : "/"))) throw new Error("Escaping test workspace");
    return value;
  };
  const store = new ProjectStore({
    readFile: async path => { try { return await readFile(target(path), "utf8"); } catch { return undefined; } },
    writeFile: async (path, content) => { const file = target(path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); },
    listDirectory: async path => { try { return await readdir(target(path)); } catch { return []; } }
  });
  try {
    const before = intent([{ id: "old", sourceFiles: ["src/old.ts"] }]);
    const diagram = analysis("old", ["src/old.ts"]);
    await store.writeIntent(before);
    await store.writeDiagram(diagram);
    const diagrams = await store.readDiagrams();
    const next = intent([{ id: "new", sourceFiles: ["src/features/project/host/new.ts"] }]);
    next.contexts[0]!.canonicalName = before.contexts[0]!.canonicalName;
    const reconciled = reconcileProjectIndex(next, await store.readIntent(), diagrams);
    await store.writeIntent(reconciled);
    expect((await store.readIntent())!.contexts[0]!.id).toBe("new");
    expect((await store.readDiagrams()).map(item => item.id)).toEqual([diagram.id]);
    const topics = buildProjectTopics(reconciled, diagrams);
    expect(topics[0]?.analysisState).toBe("outline");
    expect(readerGalleryArticle(diagrams[0]!, { topics, checks: [], diagrams, brief: "", gallery: true })).toContain("Module boundaries changed");
  } finally {
    if (dirname(directory) === tmpdir() && directory.includes("dext-history-migration-")) await rm(directory, { recursive: true, force: true });
  }
});
