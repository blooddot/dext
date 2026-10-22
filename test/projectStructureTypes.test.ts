import { describe, expect, it } from "vitest";
import { buildStructureIndex } from "../src/features/project/host/indexing/projectStructure.js";

const inputs = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, content }));

describe("structure index v4 type facts", () => {
  it("records TypeScript owners, members, modifiers and explicit heritage", async () => {
    const index = await buildStructureIndex(inputs({
      "src/model.ts": [
        "export abstract class Base<T> extends Root implements Persisted, Named {",
        "  protected static count: number = 0;",
        "  private name?: string;",
        "  abstract run(value: number): Promise<void>;",
        "  async save(): Promise<void> {}",
        "}",
        "export interface Persisted { readonly id: string; save(): void; }",
        "export interface Named extends Entity { name: string; }",
        "export enum Mode { Fast, Slow = 2 }",
        "export type Alias = string;",
        "export function topLevel(input: string): number { return input.length; }"
      ].join("\n")
    }));
    const file = index.cache.files[0]!;
    expect(file.symbols.every((symbol) => symbol.id)).toBe(true);
    const base = file.symbols.find((symbol) => symbol.name === "Base")!;
    expect(base).toMatchObject({ kind: "abstract_class_declaration", abstract: true, extends: ["Root"], implements: ["Persisted", "Named"] });
    const count = file.symbols.find((symbol) => symbol.name === "count")!;
    expect(count).toMatchObject({ ownerId: base.id, ownerName: "Base", memberKind: "field", typeText: "number", visibility: "protected", static: true });
    const name = file.symbols.find((symbol) => symbol.name === "name")!;
    expect(name).toMatchObject({ ownerId: base.id, memberKind: "field", typeText: "string", visibility: "private" });
    const run = file.symbols.find((symbol) => symbol.name === "run")!;
    expect(run).toMatchObject({ ownerId: base.id, memberKind: "method", parameters: "value: number", returns: "Promise<void>", abstract: true });
    const save = file.symbols.find((symbol) => symbol.name === "save")!;
    expect(save).toMatchObject({ ownerId: base.id, memberKind: "method", returns: "Promise<void>" });
    const persisted = file.symbols.find((symbol) => symbol.name === "Persisted")!;
    expect(persisted).toMatchObject({ kind: "interface_declaration" });
    expect(file.symbols.find((symbol) => symbol.name === "id")).toMatchObject({ ownerId: persisted.id, memberKind: "field", typeText: "string" });
    expect(file.symbols.find((symbol) => symbol.name === "Mode")).toMatchObject({ kind: "enum_declaration" });
    expect(file.symbols.some((symbol) => symbol.name === "Alias")).toBe(false);
    expect(file.symbols.find((symbol) => symbol.name === "topLevel")).toMatchObject({ kind: "function_declaration" });
    expect(file.symbols.find((symbol) => symbol.name === "topLevel")?.ownerId).toBeUndefined();
  });

  it("records Python bases, methods and class-level annotated fields", async () => {
    const index = await buildStructureIndex(inputs({
      "worker/model.py": [
        "class Base:",
        "    pass",
        "class Worker(Base):",
        "    retries: int",
        "    cache = None",
        "    @staticmethod",
        "    def make() -> 'Worker':",
        "        return Worker()",
        "    @abstractmethod",
        "    def run(self, count: int = 1) -> None:",
        "        pass"
      ].join("\n")
    }));
    const symbols = index.cache.files[0]!.symbols;
    const worker = symbols.find((symbol) => symbol.name === "Worker")!;
    expect(worker).toMatchObject({ kind: "class_definition", extends: ["Base"] });
    expect(symbols.find((symbol) => symbol.name === "retries")).toMatchObject({ ownerId: worker.id, memberKind: "field", typeText: "int" });
    expect(symbols.some((symbol) => symbol.name === "cache")).toBe(false);
    expect(symbols.find((symbol) => symbol.name === "make")).toMatchObject({ ownerId: worker.id, memberKind: "method", static: true });
    expect(symbols.find((symbol) => symbol.name === "make")?.parameters).toBeUndefined();
    expect(symbols.find((symbol) => symbol.name === "run")).toMatchObject({ ownerId: worker.id, memberKind: "method", parameters: "count: int = 1", returns: "None", abstract: true });
  });

  it("records Rust fields and impl methods without inventing trait implementation edges", async () => {
    const index = await buildStructureIndex(inputs({
      "server/src/model.rs": [
        "pub struct Foo { pub x: i32, y: String }",
        "pub trait Run { fn run(&self); }",
        "impl Foo { pub fn new() -> Self { Foo { x: 0, y: String::new() } } }",
        "impl Run for Foo { fn run(&self) {} }"
      ].join("\n")
    }));
    const symbols = index.cache.files[0]!.symbols;
    const foo = symbols.find((symbol) => symbol.name === "Foo")!;
    expect(foo).toMatchObject({ kind: "struct_item", visibility: "public" });
    expect(symbols.find((symbol) => symbol.name === "x")).toMatchObject({ ownerId: foo.id, ownerName: "Foo", memberKind: "field", typeText: "i32", visibility: "public" });
    expect(symbols.find((symbol) => symbol.name === "y")).toMatchObject({ ownerId: foo.id, memberKind: "field", typeText: "String" });
    expect(symbols.find((symbol) => symbol.name === "Run")).toMatchObject({ kind: "trait_item", visibility: "public" });
    expect(symbols.filter((symbol) => symbol.name === "new")).toHaveLength(1);
    expect(symbols.find((symbol) => symbol.name === "new")).toMatchObject({ ownerId: foo.id, ownerName: "Foo", memberKind: "method" });
    expect(symbols.every((symbol) => symbol.extends === undefined)).toBe(true);
  });
});
