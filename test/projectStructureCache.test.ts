import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStructureIndex } from "../src/features/project/host/indexing/projectStructure.js";
import { readCachedStructure, readCachedStructureGraph } from "../src/features/project/host/indexing/projectStructureHost.js";

vi.mock("vscode", () => ({ workspace: {}, Uri: {} }));

const inputs = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, content }));

describe("cached structure reads", () => {
  it("returns the summary, graph and timestamp only for the current cache version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dext-structure-cache-"));
    try {
      const index = await buildStructureIndex(inputs({ "src/code.ts": "export function execute() {}" }));
      const path = join(directory, "project-structure.json");
      await writeFile(path, JSON.stringify({ ...index.cache, dependencies: index.dependencies, summary: index.summary, updatedAt: 123 }));
      const cached = await readCachedStructure(path);
      expect(cached?.summary.version).toBe(2);
      expect(cached?.updatedAt).toBe(123);
      expect(cached?.graph.nodes.map((node) => node.path)).toEqual(["src/code.ts"]);
      expect((await readCachedStructureGraph(path))?.nodes.length).toBe(1);
      await writeFile(path, JSON.stringify({ ...index.cache, version: 3, summary: index.summary, updatedAt: 123 }));
      expect(await readCachedStructure(path)).toBeUndefined();
      await writeFile(path, "{not json");
      expect(await readCachedStructure(path)).toBeUndefined();
      expect(await readCachedStructure(join(directory, "missing.json"))).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
