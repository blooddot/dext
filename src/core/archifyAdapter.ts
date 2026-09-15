import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ProjectDiagram, ProjectDiagramKind, DiagramValidationReceipt } from "./projectDiagram.js";
import type { DiagramAdapterArtifact, DiagramAdapterCapability, DiagramAdapterDocument, DiagramAdapterExportOptions, DiagramAdapterRenderOptions, ProjectDiagramAdapter } from "./projectDiagramAdapter.js";
import { assertDiagramDocument, diagramArtifact, diagramReceipt, runDiagramProcess, withDiagramFiles, readDiagramOutput } from "./projectDiagramProcess.js";

const kinds = ["architecture", "workflow", "sequence", "data_flow", "lifecycle"] as const;
interface ArchifyDocument { project: ProjectDiagram; ir: Record<string, unknown>; ids: Record<string, string> }

/** Pinned upstream CLI runtime; never loads an upstream skill into the conversation. */
export class ArchifyAdapter implements ProjectDiagramAdapter {
  readonly id = "archify";
  readonly version = "2.17.0-dev.1+d673e830";
  readonly capabilities: readonly DiagramAdapterCapability[] = kinds.map((kind) => ({ kind, formats: ["html", "svg"], features: ["interactive", "deterministic", "validation", "path_probe", "evidence_links"] }));
  private readonly active = new Map<string, AbortController>();
  private disposed = false;
  constructor(private readonly runtimeRoot = join(process.cwd(), "vendor/project-diagrams/archify")) {}
  supports(kind: ProjectDiagramKind): boolean { return kinds.includes(kind); }
  async probe(): Promise<{ available: boolean; reason?: string }> {
    try {
      const pkg = JSON.parse(await readFile(join(this.runtimeRoot, "package.json"), "utf8")) as { version?: string };
      return pkg.version === "2.17.0-dev.1" ? { available: true } : { available: false, reason: "Unsupported Archify runtime version." };
    } catch { return { available: false, reason: "Archify runtime is unavailable." }; }
  }
  transform(project: ProjectDiagram, signal?: AbortSignal): Promise<DiagramAdapterDocument> {
    if (this.disposed || signal?.aborted) return Promise.reject(new Error("Diagram operation cancelled."));
    const receipt = diagramReceipt(project, this.id, this.version);
    if (receipt.status === "failed") return Promise.reject(new Error(receipt.issues.map((i) => i.message).join("; ")));
    const ids = Object.fromEntries(project.nodes.map((node, i) => [node.id, `n${i}`]));
    const nodes = project.nodes.map((node) => ({ id: ids[node.id], label: node.label, type: node.role === "actor" ? "external" : node.role === "store" ? "database" : "backend" }));
    const edges = [...project.relations].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((edge, i) => ({ id: `e${i}`, from: ids[edge.from], to: ids[edge.to], label: edge.label ?? edge.kind }));
    const type = project.kind === "data_flow" ? "dataflow" : project.kind;
    let ir: Record<string, unknown> = { schema_version: project.kind === "workflow" ? 2 : 1, diagram_type: type, meta: { title: project.title, quality_profile: "standard", locale: "zh-CN" } };
    if (project.kind === "architecture") ir = { ...ir, components: nodes.map((node, i) => ({ ...node, pos: [50 + (i % 4) * 320, 80 + Math.floor(i / 4) * 240], size: [220, 72] })), connections: edges };
    if (project.kind === "workflow") ir = { ...ir, lanes: [{ id: "flow", label: project.title }], nodes: nodes.map((node, i) => ({ ...node, lane: "flow", col: i, width: 180 })), edges };
    if (project.kind === "sequence") ir = { ...ir, participants: nodes, messages: edges.map((edge, i) => ({ ...edge, y: 180 + i * 90 })) };
    if (project.kind === "data_flow") ir = { ...ir, stages: nodes.map((node) => ({ label: node.label })), nodes: nodes.map((node, i) => ({ ...node, stage: i, row: 0 })), flows: edges };
    if (project.kind === "lifecycle") ir = { ...ir, lanes: [{ id: "states", label: project.title }], states: nodes.map((node, i) => ({ ...node, type: i === 0 ? "start" : "active", lane: "states", col: i })), transitions: edges };
    return Promise.resolve({ adapterId: this.id, adapterVersion: this.version, diagramId: project.id, kind: project.kind, payload: { project, ir, ids } satisfies ArchifyDocument });
  }
  async validate(document: DiagramAdapterDocument, signal?: AbortSignal): Promise<DiagramValidationReceipt> {
    assertDiagramDocument(document, this.id, this.version, signal ? { signal } : undefined);
    const { project, ir } = document.payload as ArchifyDocument;
    const receipt = diagramReceipt(project, this.id, this.version);
    if (receipt.status === "failed") return receipt;
    const available = await this.probe();
    if (!available.available) throw new Error(available.reason);
    try {
      const text = await withDiagramFiles(ir, (dir, input) => runDiagramProcess(process.execPath,
        [join(this.runtimeRoot, "bin/archify.mjs"), "validate", String(ir.diagram_type), input, "--quality", "standard", "--json"], dir, signal), "html");
      JSON.parse(text);
      return { ...receipt, metadata: { upstream: text.slice(0, 12000), runtime: this.version } };
    } catch (error) { return { ...receipt, status: "failed", issues: [{ severity: "error", code: "archify_validation", message: error instanceof Error ? error.message : String(error) }] }; }
  }
  preview(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact> { return this.render(document, options); }
  async render(document: DiagramAdapterDocument, options: DiagramAdapterRenderOptions = {}): Promise<DiagramAdapterArtifact> {
    assertDiagramDocument(document, this.id, this.version, options);
    const format = options.format ?? "html";
    if (format !== "html" && format !== "svg") throw new Error(`Archify cannot export ${format}.`);
    if (this.disposed) throw new Error("Archify adapter disposed.");
    const controller = new AbortController(); const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const operationId = options.operationId ?? document.diagramId;
    this.active.get(operationId)?.abort(); this.active.set(operationId, controller);
    try {
      const receipt = await this.validate(document, controller.signal);
      if (receipt.status === "failed") throw new Error(receipt.issues.map((i) => i.message).join("; "));
      const { ir } = document.payload as ArchifyDocument;
      const html = await withDiagramFiles(ir, async (dir, input, output) => {
        await runDiagramProcess(process.execPath, [join(this.runtimeRoot, "bin/archify.mjs"), "deliver", String(ir.diagram_type), input, output, "--quality", "standard", "--json"], dir, controller.signal);
        return readDiagramOutput(output);
      }, "html");
      const content = format === "svg" ? /<svg\b[\s\S]*?<\/svg>/i.exec(html)?.[0] : html;
      if (!content) throw new Error("Archify produced no SVG.");
      return diagramArtifact(document, format, content);
    } finally { options.signal?.removeEventListener("abort", cancel); if (this.active.get(operationId) === controller) this.active.delete(operationId); }
  }
  export(document: DiagramAdapterDocument, options: DiagramAdapterExportOptions): Promise<DiagramAdapterArtifact> { return this.render(document, options); }
  cancel(operationId: string): void { this.active.get(operationId)?.abort(); }
  dispose(): void { this.disposed = true; for (const controller of this.active.values()) controller.abort(); this.active.clear(); }
}
