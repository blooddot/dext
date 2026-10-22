import { describe, expect, it } from "vitest";
import {
attachStructureGraph,
buildProjectEvidencePackage,
ProjectAiGenerationService,
type ProjectAiProvider
} from "../src/features/project/host/generation/projectAiGeneration.js";
import { projectIntentSchema } from "../src/features/project/contracts/projectIntent.js";
import { buildStructureIndex } from "../src/features/project/host/indexing/projectStructure.js";
import type { StructureMember } from "../src/features/project/host/indexing/projectStructure.js";
import {
buildStructureGraphFromSummary,
buildStructureGraphFromMembers,
structureConsumers,
structureDependencies,
structureGraphFacts,
structureNeighborPaths,
type StructureGraph
} from "../src/features/project/host/indexing/projectStructureGraph.js";
import { responsibilityContext } from "../src/features/project/host/indexing/projectStructureKnowledge.js";
import { projectModelQuality } from "../src/features/project/host/generation/projectModelQuality.js";
import { runStructureQuery } from "../src/features/project/host/indexing/projectStructureQuery.js";

const inputs = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, content }));
const fixture = {
  "src/a.ts": 'import { b } from "./b";\nimport type { C } from "./c";\nexport function a() {}',
  "src/b.ts": 'import { c } from "./c";\nexport function b() {}',
  "src/c.ts": 'import { a } from "./a";\nexport function c() {}',
  "src/d.ts": 'import { a } from "./a";\nimport { missing } from "./missing";\nconst lazy = require(name);\nexport function d() {}'
};

async function graphFixture(): Promise<{ graph: StructureGraph; paths: string[] }> {
  const index = await buildStructureIndex(inputs(fixture));
  return { graph: index.graph, paths: index.cache.files.map(file => file.path) };
}

describe("derived structure graph", () => {
  it("derives one deterministic graph with provenance, neighbours and cycles", async () => {
    const first = await graphFixture(), second = await graphFixture();
    const { graph } = first;
    expect(graph.nodes.map(node => node.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "src/b.ts", to: "src/c.ts", provenance: "extracted", typeOnly: false }),
      expect.objectContaining({ from: "src/a.ts", to: "src/c.ts", provenance: "extracted", typeOnly: true })
    ]));
    // The unresolved dynamic require contributes no file edge, so it cannot become a cycle member.
    expect(graph.cycles).toEqual([["src/a.ts", "src/b.ts", "src/c.ts"]]);
    expect(structureConsumers(graph, "src/c.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(structureDependencies(graph, "src/b.ts")).toEqual(["src/c.ts"]);
    expect([...structureNeighborPaths(graph, ["src/d.ts"])].sort()).toEqual(["src/a.ts"]);
    expect(first.graph).toEqual(second.graph);
    expect(buildStructureGraphFromSummary((await buildStructureIndex(inputs(fixture))).summary)).toEqual(graph);
  });

  it("keeps compact facts inside the supplied evidence paths", async () => {
    const { graph } = await graphFixture();
    const facts = structureGraphFacts(graph, ["src/b.ts", "src/c.ts"]);
    expect(facts.edges).toEqual([expect.objectContaining({ from: "src/b.ts", to: "src/c.ts" })]);
    expect(facts.hubs.every(hub => ["src/b.ts", "src/c.ts"].includes(hub.id))).toBe(true);
  });

  it("detects communities deterministically without joining type-only edges", async () => {
    const members = Array.from({ length: 8 }, (_, index) => {
      const group = index < 4 ? "a" : "b";
      const number = index % 4;
      return {
        path: `src/${group}/${number}.ts`, hash: "h", language: "typescript", lines: 1, symbols: [],
        dependencies: number > 0 ? [{ specifier: `./${number - 1}`, to: `src/${group}/${number - 1}.ts` }] : []
      };
    });
    const bridge = members[0]!;
    bridge.dependencies.push({ specifier: "../b/0", to: "src/b/0.ts" });
    const first = buildStructureGraphFromMembers(members);
    const second = buildStructureGraphFromMembers([...members].reverse());
    expect(first.communities).toEqual(second.communities);
    const community = (path: string) => first.communities.find(item => item.files.includes(path))!.id;
    expect(community("src/a/1.ts")).toBe(community("src/a/2.ts"));
    expect(community("src/b/1.ts")).toBe(community("src/b/2.ts"));
    expect(new Set(first.communities.flatMap(item => item.files)).size).toBe(8);
  });

  it("surfaces community splits and cross-community dependencies only as review signals", async () => {
    const files: StructureMember[] = Array.from({ length: 6 }, (_, index) => ({
      path: `src/core/${index}.ts`, hash: "h", language: "typescript", lines: 1, symbols: [], dependencies: []
    }));
    for (const index of [1, 2, 3, 4, 5]) files[index]!.dependencies.push({ specifier: `./${index - 1}`, to: files[index - 1]!.path });
    for (let index = 3; index < 6; index++) {
      files[index]!.dependencies.push({ specifier: "./0", to: files[0]!.path });
      files[index]!.dependencies.push({ specifier: "./1", to: files[1]!.path });
    }
    const contexts = [0, 1, 2].map(index => responsibilityContext(`Area ${index + 1}`, "Part of one tight graph community",
      [files[index * 2]!, files[index * 2 + 1]!], [files[index * 2]!.path]));
    const intent = projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 0, brief: { name: "App", summary: "App" }, contexts });
    const issues = projectModelQuality(intent, files);
    expect(issues.some(issue => issue.code === "community-split" || issue.code === "module-fragmentation")).toBe(true);
    expect(issues.every(issue => issue.code === "ownership-review" || issue.contextIds.every(id => contexts.some(context => context.id === id)))).toBe(true);
  });

  it("serves bounded node, consumers, search, hubs and path queries", async () => {
    const { graph } = await graphFixture();
    expect(runStructureQuery(graph, { op: "node", path: "src/c.ts" }).nodes[0]).toMatchObject({ path: "src/c.ts", consumers: 1 });
    expect(runStructureQuery(graph, { op: "consumers", path: "src/c.ts" }).edges.map(edge => edge.from)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(runStructureQuery(graph, { op: "search", query: "src/b" }).nodes.map(node => node.path)).toEqual(["src/b.ts"]);
    expect(runStructureQuery(graph, { op: "hubs" }).nodes.length).toBeGreaterThan(0);
    expect(runStructureQuery(graph, { op: "path", from: "src/d.ts", to: "src/c.ts", maxDepth: 4 }).paths).toEqual(["src/d.ts", "src/a.ts", "src/c.ts"]);
    expect(runStructureQuery(graph, { op: "consumers", path: "../outside.ts" }).edges).toEqual([]);
  });
});

describe("diagram structure provenance", () => {
  const provider = (relation: { from: string; to: string }): ProjectAiProvider => ({
    id: "fixture",
    generate: async () => ({ text: JSON.stringify({ diagram: {
      schemaVersion: 1, id: "architecture", title: "Architecture", kind: "architecture", version: 0, updatedAt: 0,
      nodes: [
        { id: "app", label: "App", role: "system", semanticIds: [], evidence: [{ path: "src/a.ts", line: 1 }] },
        { id: "store", label: "Store", role: "module", semanticIds: [], evidence: [{ path: "src/b.ts", line: 1 }] }
      ],
      relations: [{ id: "depends", ...relation, kind: "depends_on", evidence: [{ path: "src/a.ts", line: 1 }] }]
    } }) })
  });

  it("marks a resolved import direction as extracted", async () => {
    const index = await buildStructureIndex(inputs({ "src/a.ts": 'import { b } from "./b";\nexport function a() {}', "src/b.ts": "export function b() {}" }));
    const base = buildProjectEvidencePackage({ requirement: "Show dependencies", files: [
      { path: "src/a.ts", content: 'import { b } from "./b";\nexport function a() {}' },
      { path: "src/b.ts", content: "export function b() {}" }
    ] });
    const evidence = attachStructureGraph(base, structureGraphFacts(index.graph, ["src/a.ts", "src/b.ts"]));
    expect(evidence.graph?.edges).toHaveLength(1);
    const result = await new ProjectAiGenerationService(provider({ from: "app", to: "store" }), { maxAttempts: 1 })
      .generateDiagram(evidence, { requirement: "Show dependencies" });
    expect(result.diagram.relations[0]?.metadata).toMatchObject({ provenance: "extracted", structureMatch: "direct" });
    expect(result.diagram.metadata).toMatchObject({ structureConflicts: 0, structureProvenance: "extracted:1;inferred:0" });
  });

  it("keeps a reversed relation but records a review warning", async () => {
    const index = await buildStructureIndex(inputs({ "src/a.ts": 'import { b } from "./b";\nexport function a() {}', "src/b.ts": "export function b() {}" }));
    const base = buildProjectEvidencePackage({ requirement: "Show dependencies", files: [
      { path: "src/a.ts", content: 'import { b } from "./b";\nexport function a() {}' },
      { path: "src/b.ts", content: "export function b() {}" }
    ] });
    const evidence = attachStructureGraph(base, structureGraphFacts(index.graph, ["src/a.ts", "src/b.ts"]));
    const result = await new ProjectAiGenerationService(provider({ from: "store", to: "app" }), { maxAttempts: 1 })
      .generateDiagram(evidence, { requirement: "Show dependencies" });
    expect(result.diagram.relations[0]?.metadata).toMatchObject({ provenance: "inferred", structureMatch: "reverse" });
    expect(result.diagram.metadata).toMatchObject({ structureConflicts: 1 });
    expect(String(result.diagram.metadata?.structureWarning)).toContain("opposite");
  });
});
