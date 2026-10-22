import { describe, expect, it } from "vitest";
import { buildStructureIndex } from "../src/features/project/host/indexing/projectStructure.js";
import { buildStructureMap, STRUCTURE_MAP_MAX_NODES } from "../src/features/project/host/diagrams/projectStructureMap.js";

const inputs = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, content }));

describe("structure map builder", () => {
  it("derives a deterministic project -> module -> file -> declaration tree", async () => {
    const index = await buildStructureIndex(inputs({
      "src/index.ts": "import { Store } from './store'; export function main() { return new Store(); }",
      "src/store.ts": "export class Store { save() {} } export interface Options { id: string }",
      "docs/readme.md": "# Read me"
    }));
    const first = buildStructureMap(index.summary, 42);
    const second = buildStructureMap(index.summary, 42);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.diagram.kind).toBe("tree");
    expect(first.diagram.relations).toEqual([]);
    expect(first.diagram.nodes.length).toBeLessThanOrEqual(STRUCTURE_MAP_MAX_NODES);
    expect(first.diagram.nodes[0]).toMatchObject({ id: "structure:root", evidence: [] });
    const indices = new Map(first.diagram.nodes.map((node, nodeIndex) => [node.id, nodeIndex]));
    for (const node of first.diagram.nodes) {
      if (node.parentId) expect(indices.get(node.parentId)!).toBeLessThan(indices.get(node.id)!);
    }
    const file = first.diagram.nodes.find((node) => node.id === "structure:file:src/index.ts")!;
    expect(file.evidence[0]).toMatchObject({ path: "src/index.ts", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(first.topic).toMatchObject({ id: "structure:map", kind: "structure", analysisState: "ready" });
    expect(first.topic.diagram).toBe(first.diagram);
  });

  it("bounds the module list and reports the omitted count", async () => {
    const files = Object.fromEntries(Array.from({ length: 240 }, (_, index) => [`area-${String(index).padStart(3, "0")}/file.ts`, `export function f${index}() {}`]));
    const index = await buildStructureIndex(inputs(files));
    const map = buildStructureMap(index.summary, 1);
    expect(map.diagram.nodes.length).toBeLessThanOrEqual(STRUCTURE_MAP_MAX_NODES);
    expect(map.diagram.nodes.some((node) => node.label.endsWith("more modules"))).toBe(true);
    expect(map.topic.qualityWarnings?.some((warning) => warning.includes("of 240 modules"))).toBe(true);
  });
});
