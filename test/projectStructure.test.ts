import { describe, expect, it } from "vitest";
import { buildStructureIndex, structureCacheSchema } from "../src/core/projectStructure.js";

const inputs = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, content }));
const fixture = {
  "web/package.json": '{"name":"web"}',
  "web/tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
  "web/src/main.ts": 'import { Store } from "@/data/store"; import("./view"); export class App { run() {} }',
  "web/src/data/store.ts": 'export interface Store { save(): void }; export const create = () => 1;',
  "web/src/view.tsx": 'export function View() { return <div />; }',
  "web/src/worker.js": 'const x = require("./data/store"); require(variable); export function work() {}',
  "server/Cargo.toml": '[package]\nname = "server"\nversion = "0.1.0"',
  "server/src/lib.rs": 'pub mod api; use crate::api::Request; pub trait Run { fn run(&self); }',
  "server/src/api.rs": 'pub struct Request {} impl Request { pub fn run(&self) {} }',
  "worker/pyproject.toml": '[project]\nname = "worker"',
  "worker/src/tasks/__init__.py": 'from .store import Store\nimport tasks.store\nclass Worker:\n def run(self): pass',
  "worker/src/tasks/store.py": 'class Store:\n def save(self): pass'
};

describe("local multilingual structure index (real WASM parsers)", () => {
  it("distinguishes type-only, mixed, default and side-effect TS imports and re-exports", async () => {
    const index = await buildStructureIndex(inputs({ "src/types.ts": "export interface A {}; export const B = 1; export default B;",
      "src/main.ts": [
        'import type { A } from "./types";', 'import { type A } from "./types";',
        'export type { A } from "./types";', 'export { type A } from "./types";',
        'import { type A, B } from "./types";', 'import B, { type A } from "./types";',
        'import "./types";', 'export * from "./types";'
      ].join("\n") }));
    expect(index.dependencies.map(edge => !!edge.typeOnly)).toEqual([true, true, true, true, false, false, false, false]);
    const member = index.summary.modules.flatMap(module => module.members).find(file => file.path === "src/main.ts")!;
    expect(member.dependencies.map(edge => !!edge.typeOnly)).toEqual([true, true, true, true, false, false, false, false]);
  });
  it("extracts all supported languages and resolves only supported static dependencies", async () => {
    const index = await buildStructureIndex(inputs(fixture));
    expect(index.summary.parsed).toBe(8);
    expect(index.summary.failed).toBe(0);
    expect(new Set(index.cache.files.map(file => file.language))).toEqual(new Set(["typescript", "tsx", "javascript", "rust", "python"]));
    expect(index.cache.files.find(file => file.path.endsWith("store.ts"))?.symbols.map(symbol => symbol.name)).toContain("Store");
    expect(index.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "web/src/main.ts", to: "web/src/data/store.ts", status: "resolved" }),
      expect.objectContaining({ from: "server/src/lib.rs", to: "server/src/api.rs", status: "resolved" }),
      expect.objectContaining({ from: "worker/src/tasks/__init__.py", to: "worker/src/tasks/store.py", status: "resolved" }),
      expect.objectContaining({ specifier: "<dynamic>", status: "unresolved" })
    ]));
    expect(index.summary.modules.reduce((sum, module) => sum + module.files, 0)).toBe(8);
    expect(index.summary.modules.find(module => module.path === "web/src")?.dependsOn).toContain("module:web/src/data");
  });

  it("reuses unchanged parse results, invalidates edits, drops deletions and recomputes config-dependent edges", async () => {
    const first = await buildStructureIndex(inputs(fixture));
    const second = await buildStructureIndex(inputs(fixture), { cache: first.cache });
    expect(second.summary.cached).toBe(first.summary.parsed);
    expect(second.summary.hash).toBe(first.summary.hash);
    const changed = { ...fixture, "web/tsconfig.json": '{"compilerOptions":{"paths":{"@/*":["missing/*"]}}}', "server/src/api.rs": "pub struct NewRequest {}" };
    delete (changed as Record<string, string>)["web/src/view.tsx"];
    const third = await buildStructureIndex(inputs(changed), { cache: second.cache });
    expect(third.summary.cached).toBe(first.summary.parsed - 2);
    expect(third.cache.files.some(file => file.path.endsWith("view.tsx"))).toBe(false);
    expect(third.dependencies.find(edge => edge.specifier === "@/data/store")?.status).toBe("unresolved");
    expect(third.summary.hash).not.toBe(first.summary.hash);
    expect(structureCacheSchema.safeParse({ version: 0, files: [] }).success).toBe(false);
  });

  it("retains coverage beyond 4000 files and reports unsupported, unreadable and malformed sources", async () => {
    const files = Array.from({ length: 4100 }, (_, i) => ({ path: `src/area-${i % 41}/file-${i}.ts`, content: `export function f${i}() {}` }));
    const index = await buildStructureIndex([...files, { path: "src/malformed.py", content: "def broken(" }, { path: "src/secret.ts", issue: "Unreadable" }, { path: "src/unsupported.go", content: "package main" }]);
    expect(index.summary.parsed).toBe(4101);
    expect(index.summary.modules).toHaveLength(42);
    expect(index.summary.modules.reduce((sum, module) => sum + module.files, 0)).toBe(4101);
    expect(index.summary.failed).toBe(2);
    expect(index.summary.unsupported).toBe(1);
  }, 30_000);

  it("honors cancellation without producing a completed snapshot", async () => {
    const controller = new AbortController();
    await expect(buildStructureIndex(inputs(fixture), { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow();
  });
});
