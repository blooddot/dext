import { describe, expect, it } from "vitest";
import { buildStructureIndex } from "../src/features/project/host/indexing/projectStructure.js";
import { buildClassMap, CLASS_MAP_MAX_MEMBERS, CLASS_MAP_MAX_TYPES } from "../src/features/project/host/diagrams/projectClassMap.js";

const inputs = (files: Record<string, string>) => Object.entries(files).map(([path, content]) => ({ path, content }));

describe("class map builder", () => {
  it("maps explicit types, members and only valid heritage edges", async () => {
    const index = await buildStructureIndex(inputs({
      "src/model.ts": [
        "export interface Named { name: string }",
        "export abstract class Base { protected id: string; abstract run(value: number): void; save(): void {} }",
        "export class Child extends Base implements Named { name: string; run(value: number): void {} }"
      ].join("\n")
    }));
    const map = buildClassMap(index.summary, 42);
    expect(map.diagram.kind).toBe("class");
    const child = map.diagram.nodes.find((node) => node.label === "Child")!;
    expect(child).toMatchObject({ classKind: "class", role: "module" });
    expect(child.members?.some((member) => member.name === "run" && member.kind === "method")).toBe(true);
    expect(child.evidence[0]).toMatchObject({ path: "src/model.ts", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const base = map.diagram.nodes.find((node) => node.label === "Base")!;
    expect(base).toMatchObject({ classKind: "abstract" });
    expect(base.members?.find((member) => member.name === "id")).toMatchObject({ kind: "attribute", type: "string", visibility: "protected" });
    expect(base.members?.find((member) => member.name === "run")).toMatchObject({ kind: "method", parameters: "value: number", abstract: true });
    const named = map.diagram.nodes.find((node) => node.label === "Named")!;
    expect(map.diagram.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: child.id, to: base.id, kind: "inheritance" }),
      expect.objectContaining({ from: child.id, to: named.id, kind: "realization" })
    ]));
    expect(map.topic).toMatchObject({ id: "structure:types", kind: "types", analysisState: "ready" });
    expect(map.diagram.metadata?.classMap).toBe(true);
  });

  it("skips ambiguous heritage targets and reports them", async () => {
    const index = await buildStructureIndex(inputs({
      "src/a.ts": "export class Base {}",
      "src/b.ts": "export class Base {}",
      "src/child.ts": "export class Child extends Base {}"
    }));
    const map = buildClassMap(index.summary, 1);
    expect(map.diagram.relations).toEqual([]);
    expect(map.topic.qualityWarnings?.some((warning) => warning.includes("more than one"))).toBe(true);
  });

  it("bounds the type and member budgets deterministically", async () => {
    const files = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [
      `src/type-${index}.ts`,
      `export class Type${index} { ${Array.from({ length: 20 }, (_, member) => `field${member}: string;`).join(" ")} }`
    ]));
    const index = await buildStructureIndex(inputs(files));
    const map = buildClassMap(index.summary, 1);
    expect(map.diagram.nodes.length).toBeLessThanOrEqual(CLASS_MAP_MAX_TYPES);
    expect(map.diagram.nodes.reduce((sum, node) => sum + (node.members?.length ?? 0), 0)).toBeLessThanOrEqual(CLASS_MAP_MAX_MEMBERS);
    expect(map.topic.qualityWarnings?.some((warning) => warning.includes("explicit types"))).toBe(true);
  });
});
