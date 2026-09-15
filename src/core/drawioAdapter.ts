import { join } from "node:path";
import type { ProjectDiagramKind, ProjectDiagram, DiagramValidationReceipt } from "./projectDiagram.js";
import type { DiagramAdapterArtifact, DiagramAdapterCapability, DiagramAdapterDocument, DiagramAdapterExportOptions, DiagramAdapterRenderOptions, ProjectDiagramAdapter } from "./projectDiagramAdapter.js";
import { assertDiagramDocument, diagramArtifact, diagramReceipt, runDiagramProcess, withDiagramFiles, readDiagramOutput } from "./projectDiagramProcess.js";

interface DrawioDocument { project: ProjectDiagram; ir: { schema: string; metadata: Record<string, unknown>; nodes: unknown[]; edges: unknown[]; views: Array<{ id: string; name: string; nodes: string[]; direction?: string }> } }
const kinds = ["architecture", "workflow", "sequence", "data_flow", "lifecycle"] as const;
export interface DrawioDriftDiff { added: string[]; removed: string[]; moved: string[] }
/** Compares stored draw.io geometry by stable Project ids without treating layout as semantics. */
export function diffDrawioLayout(before: string, after: string): DrawioDriftDiff {
  const geometry = (xml: string): Map<string, string> => {
    const result = new Map<string, string>();
    const re = /data-model-id="([^"]+)"[\s\S]*?<mxGeometry\s+([^>]+?)\s*\/>/g;
    for (const match of xml.matchAll(re)) result.set(match[1]!, match[2]!.replace(/\s+/g, " ").trim());
    return result;
  };
  const left = geometry(before); const right = geometry(after);
  return {
    added: [...right.keys()].filter((id) => !left.has(id)).sort(),
    removed: [...left.keys()].filter((id) => !right.has(id)).sort(),
    moved: [...right.keys()].filter((id) => left.has(id) && left.get(id) !== right.get(id)).sort()
  };
}
/** Bridge to the pinned drawio-skill stdlib scripts. The XML is always adapter output. */
export class DrawioAdapter implements ProjectDiagramAdapter {
  readonly id = "drawio";
  readonly version = "drawio-skill@7aa92f7";
  readonly capabilities: readonly DiagramAdapterCapability[] = kinds.map((kind) => ({ kind, formats: ["drawio"], features: ["editable", "deterministic", "incremental", "manual_layout", "evidence_links"] }));
  private readonly active = new Map<string, AbortController>();
  private disposed = false;
  constructor(private readonly runtimeRoot = join(process.cwd(), "vendor/project-diagrams/drawio"), private readonly python = "python3") {}
  supports(kind: ProjectDiagramKind): boolean { return kinds.includes(kind); }
  diffLayout(before: string, after: string): DrawioDriftDiff { return diffDrawioLayout(before, after); }
  transform(project: ProjectDiagram): Promise<DiagramAdapterDocument> {
    if (project.kind === "data_flow") return Promise.reject(new Error("drawio-skill bridge uses data_flow as a graph projection."));
    const ids = new Set<string>();
    const safe = (id: string): string => { const base = id.replace(/[^A-Za-z0-9_.-]/g, "-") || "node"; let value = base; let i = 2; while (ids.has(value) || value === "0" || value === "1") value = `${base}-${i++}`; ids.add(value); return value; };
    const map = new Map(project.nodes.map((node) => [node.id, safe(node.id)]));
    const nodeIds = project.nodes.map((node) => map.get(node.id)!).filter(Boolean);
    const views = [
      { id: "executive", name: "Executive", nodes: nodeIds.slice(0, Math.min(nodeIds.length, 12)), direction: "TB" },
      { id: "system", name: "System", nodes: nodeIds, direction: "LR" },
      ...(project.kind === "architecture" ? [{ id: "deployment", name: "Deployment", nodes: nodeIds, direction: "TB" }] : [])
    ];
    const ir = { schema: "drawio-skill/diagram-ir/v1", metadata: { title: project.title, projectDiagramId: project.id, kind: project.kind }, nodes: project.nodes.map((node) => ({ id: map.get(node.id), label: node.label, kind: node.role, properties: { projectId: node.id }, provenance: { evidence: node.evidence } })), edges: project.relations.map((edge) => ({ id: safe(edge.id), source: map.get(edge.from), target: map.get(edge.to), label: edge.label ?? edge.kind, kind: edge.kind, properties: { projectId: edge.id }, provenance: { evidence: edge.evidence } })), views };
    return Promise.resolve({ adapterId: this.id, adapterVersion: this.version, diagramId: project.id, kind: project.kind, payload: { project, ir } satisfies DrawioDocument });
  }
  validate(document: DiagramAdapterDocument, signal?: AbortSignal): Promise<DiagramValidationReceipt> {
    assertDiagramDocument(document, this.id, this.version, signal ? { signal } : undefined);
    const { project } = document.payload as DrawioDocument; const base = diagramReceipt(project, this.id, this.version); if (base.status === "failed") return Promise.resolve(base);
    return Promise.resolve({ ...base, metadata: { upstream: "drawio-skill validation runs after XML build" } });
  }
  preview(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact> { return this.render(document, options); }
  async render(document: DiagramAdapterDocument, options: DiagramAdapterRenderOptions = {}): Promise<DiagramAdapterArtifact> {
    assertDiagramDocument(document, this.id, this.version, options); if (options.format && options.format !== "drawio") throw new Error(`drawio-skill cannot export ${options.format}.`); if (this.disposed) throw new Error("drawio adapter disposed.");
    const operationId = options.operationId ?? document.diagramId; const controller = new AbortController(); const cancel = () => controller.abort(); options.signal?.addEventListener("abort", cancel, { once: true }); this.active.get(operationId)?.abort(); this.active.set(operationId, controller);
    try { const receipt = await this.validate(document, controller.signal); if (receipt.status === "failed") throw new Error(receipt.issues.map((i) => i.message).join("; ")); const { ir } = document.payload as DrawioDocument; const xml = await withDiagramFiles(ir, async (dir, input, output) => { const viewArg = ir.views.length ? ["--views", ir.views.map((view) => view.id).join(",")] : []; await runDiagramProcess(this.python, [join(this.runtimeRoot, "scripts/diagramctl.py"), "build", input, "--from", "ir", ...viewArg, "-o", output], dir, controller.signal); const report = await runDiagramProcess(this.python, [join(this.runtimeRoot, "scripts/validate.py"), output, "--json"], dir, controller.signal); const result = JSON.parse(report) as { errors?: number }; if ((result.errors ?? 0) > 0) throw new Error("drawio-skill validation found " + result.errors + " errors."); return readDiagramOutput(output); }, "drawio"); const overlay = options.layoutOverlay; const content = overlay?.adapterId === this.id ? xml.replace(/((?:<UserObject|<mxCell)[^>]*data-model-id="([^"]+)"[^>]*>[\s\S]*?<mxGeometry )x="[^"]*" y="[^"]*" width="[^"]*" height="[^"]*"/g, (match, prefix: string, nodeId: string) => { const position = overlay.nodes[nodeId]; return position ? `${prefix}x="${position.x}" y="${position.y}" width="${position.width ?? 160}" height="${position.height ?? 70}"` : match; }) : xml; return diagramArtifact(document, "drawio", content); }
    finally { options.signal?.removeEventListener("abort", cancel); if (this.active.get(operationId) === controller) this.active.delete(operationId); }
  }
  export(document: DiagramAdapterDocument, options: DiagramAdapterExportOptions): Promise<DiagramAdapterArtifact> { return this.render(document, options); }
  cancel(operationId: string): void { this.active.get(operationId)?.abort(); }
  dispose(): void { this.disposed = true; for (const controller of this.active.values()) controller.abort(); this.active.clear(); }
}
