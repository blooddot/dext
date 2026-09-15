import { describe, expect, it } from "vitest";
import { describeDiagramAdapter, type DiagramAdapterArtifact, type DiagramAdapterCapability, type DiagramAdapterDocument, type ProjectDiagramAdapter } from "../src/core/projectDiagramAdapter.js";
import { validateProjectDiagram, type ProjectDiagram } from "../src/core/projectDiagram.js";

const capability: DiagramAdapterCapability = {
  kind: "architecture",
  formats: ["svg", "html"],
  features: ["interactive", "deterministic", "validation", "evidence_links"]
};

class FakeAdapter implements ProjectDiagramAdapter {
  readonly id = "fake";
  readonly version = "1.0.0";
  readonly capabilities = [capability] as const;
  readonly cancelled: string[] = [];
  disposed = false;
  supports(kind: ProjectDiagram["kind"]): boolean { return this.capabilities.some((entry) => entry.kind === kind); }
  async transform(diagram: ProjectDiagram): Promise<DiagramAdapterDocument> {
    return { adapterId: this.id, adapterVersion: this.version, diagramId: diagram.id, kind: diagram.kind, payload: { nodeCount: diagram.nodes.length } };
  }
  private artifact(document: DiagramAdapterDocument, format: "svg" | "html"): DiagramAdapterArtifact {
    return { format, mimeType: format === "svg" ? "image/svg+xml" : "text/html", content: `<${format} data-diagram="${document.diagramId}" />`, adapterId: this.id, adapterVersion: this.version, diagramId: document.diagramId };
  }
  async preview(document: DiagramAdapterDocument): Promise<DiagramAdapterArtifact> { return this.artifact(document, "svg"); }
  async render(document: DiagramAdapterDocument): Promise<DiagramAdapterArtifact> { return this.artifact(document, "svg"); }
  async export(document: DiagramAdapterDocument, options: { format?: "html" | "svg" }): Promise<DiagramAdapterArtifact> { return this.artifact(document, options.format === "html" ? "html" : "svg"); }
  async validate(document: DiagramAdapterDocument) {
    return { adapterId: this.id, adapterVersion: this.version, status: "passed" as const, checkedAt: 1, issues: [], metadata: { nodeCount: String((document.payload as { nodeCount: number }).nodeCount) } };
  }
  cancel(operationId: string): void { this.cancelled.push(operationId); }
  dispose(): void { this.disposed = true; }
}

const diagram: ProjectDiagram = {
  schemaVersion: 1,
  id: "architecture",
  title: "Example",
  kind: "architecture",
  version: 1,
  updatedAt: 1,
  nodes: [{ id: "app", label: "App", role: "system", semanticIds: [], evidence: [{ path: "src/app.ts", line: 1 }] }],
  relations: []
};

describe("Project diagram adapter contract", () => {
  it("keeps identity and capabilities renderer-neutral", async () => {
    const adapter = new FakeAdapter();
    expect(adapter.supports("architecture")).toBe(true);
    expect(adapter.supports("workflow")).toBe(false);
    expect(describeDiagramAdapter(adapter)).toEqual({ id: "fake", version: "1.0.0", capabilities: [capability] });
    const document = await adapter.transform(diagram);
    expect(document.payload).toEqual({ nodeCount: 1 });
    expect((await adapter.preview(document)).format).toBe("svg");
    expect((await adapter.export(document, { format: "html" })).mimeType).toBe("text/html");
    expect((await adapter.validate(document)).status).toBe("passed");
    adapter.cancel?.("op-1");
    adapter.dispose();
    expect(adapter.cancelled).toEqual(["op-1"]);
    expect(adapter.disposed).toBe(true);
  });

  it("detects renderer-independent dangling references before adapter invocation", () => {
    const invalid: ProjectDiagram = {
      ...diagram,
      relations: [{ id: "r", from: "app", to: "missing", kind: "calls", evidence: [] }]
    };
    const issues = validateProjectDiagram(invalid);
    expect(issues.some((issue) => issue.code === "dangling_relation")).toBe(true);
  });
});
