import type { ProjectDiagram, ProjectDiagramKind, DiagramValidationReceipt } from "./projectDiagram.js";
import { diagramReceipt } from "./projectDiagramProcess.js";
import type { DiagramAdapterArtifact, DiagramAdapterCapability, DiagramAdapterDocument, DiagramAdapterExportOptions, DiagramAdapterRenderOptions, ProjectDiagramAdapter } from "./projectDiagramAdapter.js";
const kinds: readonly ProjectDiagramKind[] = ["architecture", "workflow", "sequence", "data_flow", "lifecycle"];
const id = (value: string, index: number, seen: Set<string>): string => { const base = value.replace(/[^A-Za-z0-9_]/g, "_") || "node"; let out = base; while (seen.has(out)) out = `${base}_${index + 1}`; seen.add(out); return out; };
const esc = (value: string): string => value.replace(/[\n\r`]/g, " ").replace(/"/g, "&quot;");
export class MermaidAdapter implements ProjectDiagramAdapter {
  readonly id = "mermaid"; readonly version = "11-compatible-1";
  readonly capabilities: readonly DiagramAdapterCapability[] = kinds.map((kind) => ({ kind, formats: ["mermaid", "markdown"], features: ["deterministic", "evidence_links"] }));
  supports(kind: ProjectDiagramKind): boolean { return kinds.includes(kind); }
  transform(diagram: ProjectDiagram): Promise<DiagramAdapterDocument> { return Promise.resolve({ adapterId: this.id, adapterVersion: this.version, diagramId: diagram.id, kind: diagram.kind, payload: diagram }); }
  private artifact(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): DiagramAdapterArtifact {
    const diagram = document.payload as ProjectDiagram; const seen = new Set<string>(); const ids = new Map(diagram.nodes.map((node, index) => [node.id, id(node.id, index, seen)]));
    let lines: string[];
    if (diagram.kind === "sequence") lines = ["sequenceDiagram", ...diagram.nodes.map((node) => `  participant ${ids.get(node.id)} as ${esc(node.label)}`), ...diagram.relations.map((edge) => `  ${ids.get(edge.from)}->>${ids.get(edge.to)}: ${esc(edge.label ?? edge.kind)}`)];
    else if (diagram.kind === "lifecycle") lines = ["stateDiagram-v2", ...diagram.relations.map((edge) => `  ${ids.get(edge.from)} --> ${ids.get(edge.to)}: ${esc(edge.label ?? edge.kind)}`), ...diagram.nodes.map((node) => `  ${ids.get(node.id)}: ${esc(node.label)}`)];
    else lines = [diagram.kind === "data_flow" ? "flowchart LR" : "flowchart TD", ...diagram.nodes.map((node) => `  ${ids.get(node.id)}["${esc(node.label)}"]`), ...diagram.relations.map((edge) => `  ${ids.get(edge.from)} -->|${esc(edge.label ?? edge.kind)}| ${ids.get(edge.to)}`)];
    const format = options?.format === "markdown" ? "markdown" : "mermaid"; return { format, mimeType: "text/plain", content: format === "markdown" ? `\n\`\`\`mermaid\n${lines.join("\n")}\n\`\`\`\n` : lines.join("\n"), adapterId: this.id, adapterVersion: this.version, diagramId: document.diagramId };
  }
  preview(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact> { return Promise.resolve(this.artifact(document, options)); }
  render(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact> { if (document.adapterId !== this.id || document.adapterVersion !== this.version) return Promise.reject(new Error("Unsupported Mermaid document version.")); const diagram = document.payload as ProjectDiagram; if (diagram.freshness && diagram.freshness !== "current") return Promise.reject(new Error("Cannot render stale Project diagram.")); if (options?.format && options.format !== "mermaid" && options.format !== "markdown") return Promise.reject(new Error(`Mermaid cannot render ${options.format}.`)); return Promise.resolve(this.artifact(document, options)); }
  export(document: DiagramAdapterDocument, options: DiagramAdapterExportOptions): Promise<DiagramAdapterArtifact> { if (options.format && options.format !== "mermaid" && options.format !== "markdown") return Promise.reject(new Error(`Mermaid cannot export ${options.format}.`)); return Promise.resolve(this.artifact(document, options)); }
  validate(document: DiagramAdapterDocument): Promise<DiagramValidationReceipt> { const receipt = diagramReceipt(document.payload as ProjectDiagram, this.id, this.version); if (document.adapterVersion !== this.version) return Promise.resolve({ ...receipt, status: "failed", issues: [{ severity: "error", code: "adapter_version", message: "Mermaid adapter document version is incompatible." }] }); return Promise.resolve(receipt); }
  dispose(): void {}
}
