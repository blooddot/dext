import { describe, expect, it } from "vitest";
import { runProjectQuery } from "../src/features/project/host/indexing/projectModelMcp.js";
import { projectModelSchema } from "../src/features/project/contracts/projectModel.js";

describe("Project query tool", () => {
  it("bounds bodies, rejects extra write fields and leaves the source untouched", () => {
    const model = projectModelSchema.parse({ schemaVersion: 1, revision: 3, updatedAt: 0, relations: [], nodes: [{ id: "contract", title: "Contract", canonicalName: "Contract", kind: "contract", body: { kind: "inline", text: "x".repeat(100_000) } }] });
    const before = JSON.stringify(model);
    expect(runProjectQuery(model, { operation: "summary" })).toMatchObject({ revision: 3, nodes: [], truncated: true });
    expect(() => runProjectQuery(model, { operation: "node", id: "contract", write: true })).toThrow();
    expect(JSON.stringify(model)).toBe(before);
  });
});
