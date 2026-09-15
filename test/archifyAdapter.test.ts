import { describe, expect, it } from "vitest";
import { ArchifyAdapter } from "../src/core/archifyAdapter.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";

const diagram: ProjectDiagram = {
  schemaVersion: 1, id: "a", title: "Architecture", kind: "architecture", version: 1, updatedAt: 1,
  nodes: [{ id: "app", label: "App", role: "system", semanticIds: [], evidence: [{ path: "src/app.ts", line: 1 }] }], relations: []
};

describe("ArchifyAdapter", () => {
  it("keeps Project identity while producing a preview and receipt", async () => {
    const adapter = new ArchifyAdapter();
    const document = await adapter.transform(diagram);
    expect(document.adapterId).toBe("archify");
    expect((await adapter.preview(document)).diagramId).toBe("a");
    expect((await adapter.validate(document)).adapterId).toBe("archify");
    adapter.dispose();
  });
});
