import type { ProjectDiagram, ProjectDiagramKind, ProjectDiagramNode } from "./projectDiagram.js";
import { validationStatus, validateProjectDiagram, type DiagramValidationReceipt } from "./projectDiagram.js";
import type { DiagramAdapterArtifact, DiagramAdapterCapability, DiagramAdapterDocument, DiagramAdapterExportOptions, DiagramAdapterRenderOptions, ProjectDiagramAdapter } from "./projectDiagramAdapter.js";
const safe = (value: string, fallback: string): string => value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "_") || fallback;
const quote = (value: string): string => `"${value.replace(/[\r\n"]/g, " ").trim()}"`;

export class StructurizrAdapter implements ProjectDiagramAdapter {
  readonly id = "structurizr"; readonly version = "1";
  readonly capabilities: readonly DiagramAdapterCapability[] = [{ kind: "architecture", formats: ["structurizr", "markdown"], features: ["deterministic", "validation", "evidence_links"] }];
  supports(kind: ProjectDiagramKind): boolean { return kind === "architecture"; }
  transform(diagram: ProjectDiagram): Promise<DiagramAdapterDocument> { if (!this.supports(diagram.kind)) return Promise.reject(new Error("Structurizr supports architecture diagrams only.")); return Promise.resolve({ adapterId: this.id, adapterVersion: this.version, diagramId: diagram.id, kind: diagram.kind, payload: diagram }); }
  private artifact(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions | DiagramAdapterExportOptions): DiagramAdapterArtifact {
    if (document.adapterId !== this.id || document.adapterVersion !== this.version) throw new Error("Unsupported Structurizr document version.");
    const diagram = document.payload as ProjectDiagram; const nodes = [...diagram.nodes];
    const root = nodes.find((node) => node.role === "system") ?? ({ id: "project", label: diagram.title, role: "system", semanticIds: [], evidence: [] } satisfies ProjectDiagramNode);
    const ids = new Map<string, string>(); ids.set(root.id, "project"); const used = new Set(["project"]);
    for (const node of nodes) if (node.id !== root.id) { const base = safe(node.id, "element"); let id = base; let suffix = 2; while (used.has(id)) id = `${base}_${suffix++}`; used.add(id); ids.set(node.id, id); }
    const child = new Map<string | undefined, ProjectDiagramNode[]>();
    for (const node of nodes.filter((node) => node.id !== root.id)) { const parent = node.parentId && ids.has(node.parentId) ? node.parentId : root.id; const values = child.get(parent) ?? []; values.push(node); child.set(parent, values); }
    const lines = ["workspace {", "  model {", `    project = softwareSystem ${quote(root.label)} {`];
    const emit = (parent: string, depth: number): void => { for (const node of child.get(parent) ?? []) { const id = ids.get(node.id)!; const children = child.get(node.id) ?? []; const component = node.role === "component" || (!children.length && node.role === "module"); lines.push(`${" ".repeat(depth)}${id} = ${component ? "component" : "container"} ${quote(node.label)}${children.length ? " {" : ""}`); if (children.length) { emit(node.id, depth + 2); lines.push(`${" ".repeat(depth)}}`); } } };
    emit(root.id, 6); lines.push("    }");
    for (const relation of diagram.relations) { const from = relation.from === root.id ? "project" : ids.get(relation.from); const to = relation.to === root.id ? "project" : ids.get(relation.to); if (from && to) lines.push(`    ${from} -> ${to} ${quote(relation.label ?? relation.kind)}`); }
    lines.push("  }", "  views {", "    systemLandscape { include * autoLayout }", "    systemContext project { include * autoLayout }", "    container project { include * autoLayout }", "  }", "}");
    const format = options?.format ?? "structurizr"; if (format !== "structurizr" && format !== "markdown") throw new Error(`Structurizr cannot export '${format}'.`);
    return { format, mimeType: "text/plain", content: format === "markdown" ? `\n\`\`\`dsl\n${lines.join("\n")}\n\`\`\`\n` : lines.join("\n"), adapterId: this.id, adapterVersion: this.version, diagramId: document.diagramId };
  }
  preview(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact> { return Promise.resolve().then(() => this.artifact(document, options)); }
  render(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact> { return Promise.resolve().then(() => this.artifact(document, options)); }
  export(document: DiagramAdapterDocument, options: DiagramAdapterExportOptions): Promise<DiagramAdapterArtifact> { return Promise.resolve().then(() => this.artifact(document, options)); }
  validate(document: DiagramAdapterDocument): Promise<DiagramValidationReceipt> { const issues = document.adapterId !== this.id || document.adapterVersion !== this.version ? [{ code: "unsupported_document", message: "Document was not produced by this Structurizr adapter version.", severity: "error" as const }] : validateProjectDiagram(document.payload as ProjectDiagram); return Promise.resolve({ adapterId: this.id, adapterVersion: this.version, status: validationStatus(issues), checkedAt: Date.now(), issues }); }
  dispose(): void {}
}
