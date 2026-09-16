import type {
  DiagramValidationReceipt,
  ProjectDiagram,
  ProjectDiagramKind
} from "./projectDiagram.js";

/** Output formats the Archify viewer can produce. HTML and SVG are the only product formats. */
export type DiagramArtifactFormat = "html" | "svg";

export interface DiagramAdapterCapability {
  kind: ProjectDiagramKind;
  formats: readonly DiagramArtifactFormat[];
  /** Human-readable feature flags used by Project's diagnostics. */
  features: readonly ("interactive" | "deterministic" | "validation" | "path_probe" | "evidence_links")[];
}

export interface DiagramAdapterArtifact {
  format: DiagramArtifactFormat;
  mimeType: string;
  /** Text formats use string; binary formats may use Uint8Array. */
  content: string | Uint8Array;
  adapterId: string;
  adapterVersion: string;
  diagramId: string;
}

/** Adapter-owned intermediate document. It must not be persisted as Project truth. */
export interface DiagramAdapterDocument {
  adapterId: string;
  adapterVersion: string;
  diagramId: string;
  kind: ProjectDiagramKind;
  payload: unknown;
}

export interface DiagramAdapterRenderOptions {
  /** Optional explicit output format. Adapter chooses a default when omitted. */
  format?: DiagramArtifactFormat;
  /** Stable operation id so Project can cancel a single in-flight operation. */
  operationId?: string;
  signal?: AbortSignal;
}

export interface DiagramAdapterExportOptions extends DiagramAdapterRenderOptions {
  /** Optional destination hint; adapters must not write files unless explicitly requested by Project. */
  destination?: string;
}

/**
 * Common contract for Archify and any future adapter. Project owns the semantic IR; the adapter
 * owns only conversion, validation and presentation.
 */
export interface ProjectDiagramAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly DiagramAdapterCapability[];

  supports(kind: ProjectDiagramKind): boolean;
  /** Convert canonical Project IR to adapter-owned representation. */
  transform(diagram: ProjectDiagram, signal?: AbortSignal): Promise<DiagramAdapterDocument>;
  /** Produce an in-UI preview artifact. */
  preview(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact>;
  /** Render a final artifact in the requested format. */
  render(document: DiagramAdapterDocument, options?: DiagramAdapterRenderOptions): Promise<DiagramAdapterArtifact>;
  /** Export an artifact; writing is performed by Project after this call. */
  export(document: DiagramAdapterDocument, options: DiagramAdapterExportOptions): Promise<DiagramAdapterArtifact>;
  /** Validate adapter-specific constraints and return the unified receipt shape. */
  validate(document: DiagramAdapterDocument, signal?: AbortSignal): Promise<DiagramValidationReceipt>;
  /** Cancel a previously started operation, if supported. */
  cancel?(operationId: string): void;
  dispose(): void;
}

/** Returns a compact capability record for UI and logs without leaking adapter internals. */
export function describeDiagramAdapter(adapter: ProjectDiagramAdapter): { id: string; version: string; capabilities: readonly DiagramAdapterCapability[] } {
  return { id: adapter.id, version: adapter.version, capabilities: adapter.capabilities };
}
