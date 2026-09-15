import { describe, expect, it } from "vitest";
import { DrawioAdapter, diffDrawioLayout } from "../src/core/drawioAdapter.js";
import type { ProjectDiagram } from "../src/core/projectDiagram.js";

const diagram: ProjectDiagram = {
  schemaVersion: 1, id: "d", title: "Editable", kind: "architecture", version: 1, updatedAt: 1,
  nodes: [{ id: "app", label: "App", role: "system", semanticIds: [], evidence: [{ path: "src/app.ts" }] }], relations: []
};

describe("DrawioAdapter", () => {
  it("emits editable XML with stable Project node ids", async () => {
    const adapter = new DrawioAdapter();
    const artifact = await adapter.render(await adapter.transform(diagram));
    expect(artifact.format).toBe("drawio");
    expect(artifact.content).toContain('id="app"');
    expect((await adapter.validate(await adapter.transform(diagram))).adapterId).toBe("drawio");
    adapter.dispose();
  });

  it("uses a draw.io layout overlay without changing semantic ids", async () => {
    const adapter = new DrawioAdapter();
    const withLayout = { ...diagram, layoutOverlay: { adapterId: "drawio", version: 1, updatedAt: 1, nodes: { app: { x: 300, y: 220, width: 200, height: 60 } } } };
    const artifact = await adapter.render(await adapter.transform(diagram), { layoutOverlay: withLayout.layoutOverlay });
    expect(artifact.content).toContain('x="300" y="220" width="200" height="60"');
    expect(artifact.content).toContain('id="app"');
  });

  it("reports geometry drift by stable Project id", () => {
    const before = '<UserObject data-model-id="app"><mxGeometry x="1" y="2" /></UserObject>';
    const after = '<UserObject data-model-id="app"><mxGeometry x="3" y="2" /></UserObject><UserObject data-model-id="new"><mxGeometry x="1" y="1" /></UserObject>';
    expect(diffDrawioLayout(before, after)).toEqual({ added: ["new"], removed: [], moved: ["app"] });
  });
});
