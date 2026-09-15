import { validateProjectDiagram, validationStatus, type DiagramValidationIssue, type DiagramValidationReceipt, type ProjectDiagram, type ProjectDiagramKind, type ProjectDiagramLayoutOverlay } from "./projectDiagram.js";
import type { DiagramAdapterArtifact, DiagramAdapterDocument, DiagramAdapterExportOptions, DiagramArtifactFormat, ProjectDiagramAdapter } from "./projectDiagramAdapter.js";
import { createDiagramSnapshot, isUsableDiagramSnapshot, type ProjectDiagramSnapshot } from "./projectDiagramHistory.js";

const DEFAULT_ORDER: Record<ProjectDiagramKind, readonly string[]> = {
  architecture: ["structurizr", "archify", "drawio"],
  workflow: ["archify", "drawio", "mermaid"],
  sequence: ["archify", "drawio", "mermaid"],
  data_flow: ["archify", "drawio", "mermaid"],
  lifecycle: ["archify", "drawio", "mermaid"]
};

export interface ProjectDiagramAdapterPreferences {
  schemaVersion: 1;
  byKind: Partial<Record<ProjectDiagramKind, string>>;
  byDiagram: Record<string, string>;
}

export interface DiagramAdapterChoice {
  id: string;
  version?: string;
  available: boolean;
  supported: boolean;
  preferred: boolean;
  formats: readonly DiagramArtifactFormat[];
  reason?: string;
}

export interface DiagramRenderAttempt {
  adapterId: string;
  adapterVersion?: string;
  status: "unsupported" | "failed" | "rendered" | "cancelled";
  stage: "selection" | "transform" | "validate" | "render" | "artifact";
  issues: readonly DiagramValidationIssue[];
}

export interface ProjectDiagramRenderOptions extends DiagramAdapterExportOptions {
  /** Explicit single-view override; otherwise per-diagram and per-kind preferences apply. */
  adapterId?: string;
  allowFallback?: boolean;
  previous?: ProjectDiagramSnapshot;
  layoutOverlay?: ProjectDiagramLayoutOverlay;
}

export interface ProjectDiagramRenderOutcome {
  status: "rendered" | "failed" | "cancelled";
  diagramId: string;
  requestedAdapterId?: string;
  adapterId?: string;
  artifact?: DiagramAdapterArtifact;
  snapshot?: ProjectDiagramSnapshot;
  /** Includes Project validation and the selected adapter's validation. */
  receipt: DiagramValidationReceipt;
  attempts: readonly DiagramRenderAttempt[];
  fallback: boolean;
  usedLastGood: boolean;
}

interface ActiveRender {
  controller: AbortController;
  adapter?: ProjectDiagramAdapter;
}

class DiagramRenderCancelled extends Error {
  constructor() { super("Diagram rendering was cancelled."); this.name = "AbortError"; }
}

function adapterId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error("Invalid diagram adapter id.");
  return value;
}

function issue(code: string, message: string): DiagramValidationIssue { return { code, message, severity: "error" }; }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function receipt(id: string, version: string, issues: readonly DiagramValidationIssue[]): DiagramValidationReceipt {
  return { adapterId: id, adapterVersion: version, status: validationStatus(issues), checkedAt: Date.now(), issues };
}

/** Stops waiting even when an external renderer ignores AbortSignal. Late results cannot be promoted. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DiagramRenderCancelled());
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    work.then((value) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(new DiagramRenderCancelled()); else resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(signal.aborted ? new DiagramRenderCancelled() : error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function documentIssues(document: DiagramAdapterDocument, adapter: ProjectDiagramAdapter, diagram: ProjectDiagram): DiagramValidationIssue[] {
  if (!document || typeof document !== "object" || document.adapterId !== adapter.id || document.adapterVersion !== adapter.version || document.diagramId !== diagram.id || document.kind !== diagram.kind || !("payload" in document)) {
    return [issue("invalid_adapter_document", `Adapter '${adapter.id}' returned a document with a mismatched identity, version or diagram kind.`)];
  }
  return [];
}

function receiptIssues(value: DiagramValidationReceipt, adapter: ProjectDiagramAdapter): DiagramValidationIssue[] {
  const raw: unknown = value;
  if (!raw || typeof raw !== "object") return [issue("invalid_validation_receipt", `Adapter '${adapter.id}' returned an invalid validation receipt.`)];
  const record = raw as Record<string, unknown>;
  const rawIssues: unknown = record["issues"];
  const validIssues = Array.isArray(rawIssues) && rawIssues.every((entry: unknown): entry is DiagramValidationIssue => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Record<string, unknown>;
    return typeof candidate["code"] === "string" && typeof candidate["message"] === "string" && (candidate["severity"] === "info" || candidate["severity"] === "warning" || candidate["severity"] === "error");
  });
  if (record["adapterId"] !== adapter.id || record["adapterVersion"] !== adapter.version || (record["status"] !== "passed" && record["status"] !== "warning" && record["status"] !== "failed") || typeof record["checkedAt"] !== "number" || !Number.isFinite(record["checkedAt"]) || !validIssues) {
    return [issue("invalid_validation_receipt", `Adapter '${adapter.id}' returned an invalid validation receipt.`)];
  }
  const issues = rawIssues as readonly DiagramValidationIssue[];
  if (record["status"] === "failed" && !issues.some((entry: DiagramValidationIssue) => entry.severity === "error")) return [...issues, issue("adapter_validation_failed", `Adapter '${adapter.id}' rejected the diagram.`)];
  return [...issues];
}

const MIME_TYPES: Record<DiagramArtifactFormat, readonly string[]> = {
  html: ["text/html"], svg: ["image/svg+xml"], png: ["image/png"], drawio: ["application/xml", "text/xml", "application/vnd.jgraph.mxfile"],
  mermaid: ["text/plain", "text/vnd.mermaid"], structurizr: ["text/plain"], markdown: ["text/markdown", "text/plain"]
};

function artifactIssues(artifact: DiagramAdapterArtifact, adapter: ProjectDiagramAdapter, diagram: ProjectDiagram, format?: DiagramArtifactFormat): DiagramValidationIssue[] {
  if (!artifact || typeof artifact !== "object" || artifact.adapterId !== adapter.id || artifact.adapterVersion !== adapter.version || artifact.diagramId !== diagram.id) {
    return [issue("invalid_artifact_identity", `Adapter '${adapter.id}' returned an artifact belonging to a different adapter, version or diagram.`)];
  }
  const formats = adapter.capabilities.find((capability) => capability.kind === diagram.kind)?.formats ?? [];
  if (!formats.includes(artifact.format) || (format !== undefined && artifact.format !== format)) return [issue("invalid_artifact_format", `Adapter '${adapter.id}' did not return the requested supported format.`)];
  const mime = typeof artifact.mimeType === "string" ? artifact.mimeType.split(";", 1)[0]!.trim().toLowerCase() : "";
  if (!MIME_TYPES[artifact.format]?.includes(mime)) return [issue("invalid_artifact_mime", `Adapter '${adapter.id}' returned an incompatible MIME type.`)];
  if (!(typeof artifact.content === "string" || artifact.content instanceof Uint8Array) || artifact.content.length === 0) return [issue("empty_artifact", `Adapter '${adapter.id}' returned an empty or invalid artifact.`)];
  if (artifact.format !== "png" && typeof artifact.content !== "string") return [issue("invalid_text_artifact", `Adapter '${adapter.id}' returned binary content for a text format.`)];
  if (artifact.format === "png" && (!(artifact.content instanceof Uint8Array) || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => artifact.content[index] === byte))) return [issue("invalid_png_artifact", `Adapter '${adapter.id}' returned invalid PNG data.`)];
  const bytes = typeof artifact.content === "string" ? new TextEncoder().encode(artifact.content).byteLength : artifact.content.byteLength;
  if (bytes > 16 * 1024 * 1024) return [issue("artifact_too_large", "Diagram output exceeds the 16 MiB artifact limit.")];
  return [];
}

export class ProjectDiagramAdapterRegistry {
  private readonly adapters = new Map<string, ProjectDiagramAdapter>();
  private readonly preferences = new Map<ProjectDiagramKind, string>();
  private readonly diagramPreferences = new Map<string, string>();
  private readonly active = new Map<string, ActiveRender>();
  private sequence = 0;
  private disposed = false;

  register(adapter: ProjectDiagramAdapter): void {
    if (this.disposed) throw new Error("Diagram adapter registry has been disposed.");
    adapterId(adapter.id);
    if (this.adapters.has(adapter.id)) throw new Error(`Diagram adapter '${adapter.id}' is already registered.`);
    this.adapters.set(adapter.id, adapter);
  }
  unregister(id: string): void {
    for (const [operationId, active] of this.active) if (active.adapter?.id === id) this.cancel(operationId);
    this.adapters.get(id)?.dispose(); this.adapters.delete(id);
  }
  setPreference(kind: ProjectDiagramKind, adapterId: string | undefined): void {
    if (adapterId === undefined || adapterId === "auto") this.preferences.delete(kind);
    else this.preferences.set(kind, this.validPreference(adapterId));
  }
  setDiagramPreference(diagramId: string, selected: string | undefined): void {
    if (!diagramId.trim()) throw new Error("Diagram preference requires a diagram id.");
    if (selected === undefined || selected === "auto") this.diagramPreferences.delete(diagramId);
    else this.diagramPreferences.set(diagramId, this.validPreference(selected));
  }
  private validPreference(id: string): string { return adapterId(id); }
  preference(kind: ProjectDiagramKind): string | undefined { return this.preferences.get(kind); }
  diagramPreference(diagramId: string): string | undefined { return this.diagramPreferences.get(diagramId); }
  list(): ProjectDiagramAdapter[] { return [...this.adapters.values()]; }

  private order(kind: ProjectDiagramKind, diagramId?: string, explicit?: string): string[] {
    const preferred = explicit ?? (diagramId ? this.diagramPreferences.get(diagramId) : undefined) ?? this.preferences.get(kind);
    return [...new Set([...(preferred && preferred !== "auto" ? [preferred] : []), ...DEFAULT_ORDER[kind], ...[...this.adapters.keys()].sort()])];
  }

  choices(kind: ProjectDiagramKind, format?: DiagramArtifactFormat, diagramId?: string): DiagramAdapterChoice[] {
    const preferred = (diagramId ? this.diagramPreferences.get(diagramId) : undefined) ?? this.preferences.get(kind);
    return this.order(kind, diagramId).map((id) => this.choice(id, kind, format, preferred));
  }

  private choice(id: string, kind: ProjectDiagramKind, format?: DiagramArtifactFormat, preferred?: string): DiagramAdapterChoice {
    const adapter = this.adapters.get(id);
    if (!adapter) return { id, available: false, supported: false, preferred: preferred === id, formats: [], reason: `Adapter '${id}' is not installed or is disabled.` };
    const capability = adapter.capabilities.find((entry) => entry.kind === kind);
    let supported = false;
    let reason: string | undefined;
    try {
      supported = Boolean(capability && adapter.supports(kind) && (format === undefined || capability.formats.includes(format)));
      if (!supported) reason = capability && format !== undefined ? `Adapter '${id}' cannot export ${kind} as ${format}.` : `Adapter '${id}' does not support ${kind}.`;
    } catch (error) { reason = `Adapter '${id}' capability check failed: ${errorMessage(error)}`; }
    return { id, version: adapter.version, available: true, supported, preferred: preferred === id, formats: capability?.formats ?? [], ...(reason ? { reason } : {}) };
  }

  candidates(kind: ProjectDiagramKind, diagramId?: string): ProjectDiagramAdapter[] {
    return this.choices(kind, undefined, diagramId).filter((choice) => choice.supported).map((choice) => this.adapters.get(choice.id)!);
  }

  select(kind: ProjectDiagramKind, diagramId?: string): ProjectDiagramAdapter | undefined { return this.candidates(kind, diagramId)[0]; }
  defaults(kind: ProjectDiagramKind): readonly string[] { return DEFAULT_ORDER[kind]; }

  exportPreferences(): ProjectDiagramAdapterPreferences {
    return { schemaVersion: 1, byKind: Object.fromEntries([...this.preferences].sort(([a], [b]) => a.localeCompare(b))), byDiagram: Object.fromEntries([...this.diagramPreferences].sort(([a], [b]) => a.localeCompare(b))) };
  }

  /** Unknown adapter ids are retained, so temporarily disabling a plugin does not lose the user's choice. */
  importPreferences(input: unknown): void {
    if (!input || typeof input !== "object") throw new Error("Invalid diagram adapter preferences.");
    const stored = input as ProjectDiagramAdapterPreferences;
    if (stored.schemaVersion !== 1 || !stored.byKind || typeof stored.byKind !== "object" || Array.isArray(stored.byKind) || !stored.byDiagram || typeof stored.byDiagram !== "object" || Array.isArray(stored.byDiagram)) throw new Error("Unsupported diagram adapter preferences.");
    const byKind = new Map<ProjectDiagramKind, string>();
    const byDiagram = new Map<string, string>();
    for (const [kind, selected] of Object.entries(stored.byKind)) {
      if (!(kind in DEFAULT_ORDER) || typeof selected !== "string") throw new Error("Invalid diagram-kind adapter preference.");
      if (selected !== "auto") byKind.set(kind as ProjectDiagramKind, this.validPreference(selected));
    }
    for (const [id, selected] of Object.entries(stored.byDiagram)) {
      if (!id.trim() || typeof selected !== "string") throw new Error("Invalid per-diagram adapter preference.");
      if (selected !== "auto") byDiagram.set(id, this.validPreference(selected));
    }
    this.preferences.clear(); this.diagramPreferences.clear();
    for (const [key, value] of byKind) this.preferences.set(key, value);
    for (const [key, value] of byDiagram) this.diagramPreferences.set(key, value);
  }

  render(diagram: ProjectDiagram, options: ProjectDiagramRenderOptions = {}): Promise<ProjectDiagramRenderOutcome> { return this.execute("render", diagram, options); }
  preview(diagram: ProjectDiagram, options: ProjectDiagramRenderOptions = {}): Promise<ProjectDiagramRenderOutcome> { return this.execute("preview", diagram, options); }
  export(diagram: ProjectDiagram, options: ProjectDiagramRenderOptions = {}): Promise<ProjectDiagramRenderOutcome> { return this.execute("export", diagram, options); }

  private async execute(mode: "render" | "preview" | "export", diagram: ProjectDiagram, options: ProjectDiagramRenderOptions): Promise<ProjectDiagramRenderOutcome> {
    const requestedAdapterId = options.adapterId !== "auto" ? options.adapterId ?? this.diagramPreferences.get(diagram.id) ?? this.preferences.get(diagram.kind) : undefined;
    const attempts: DiagramRenderAttempt[] = [];
    let projectIssues: DiagramValidationIssue[];
    try { projectIssues = validateProjectDiagram(diagram); }
    catch (error) { projectIssues = [issue("invalid_project_diagram", errorMessage(error))]; }
    const failure = (status: "failed" | "cancelled", issues: readonly DiagramValidationIssue[]): ProjectDiagramRenderOutcome => {
      const previous = options.previous?.diagram.id === diagram.id && isUsableDiagramSnapshot(options.previous) ? options.previous : undefined;
      return {
        status, diagramId: diagram.id, ...(requestedAdapterId ? { requestedAdapterId } : {}),
        ...(previous ? { artifact: structuredClone(previous.artifact), snapshot: structuredClone(previous), adapterId: previous.artifact.adapterId } : {}),
        receipt: receipt("project", "1", issues), attempts, fallback: Boolean(previous), usedLastGood: Boolean(previous)
      };
    };
    if (this.disposed) return failure("failed", [issue("registry_disposed", "Diagram adapter registry has been disposed.")]);
    if (options.signal?.aborted) return failure("cancelled", [issue("cancelled", "Diagram rendering was cancelled.")]);
    if (projectIssues.some((entry) => entry.severity === "error")) return failure("failed", projectIssues);

    const operationId = options.operationId ?? `project-diagram-${++this.sequence}`;
    this.cancel(operationId);
    const active: ActiveRender = { controller: new AbortController() };
    this.active.set(operationId, active);
    const cancel = (): void => this.cancel(operationId);
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const signal = active.controller.signal;
    const order = this.order(diagram.kind, diagram.id, options.adapterId);
    const selectedIds = options.allowFallback === false ? order.slice(0, 1) : order;
    try {
      for (const id of selectedIds) {
        if (signal.aborted) return failure("cancelled", [...projectIssues, issue("cancelled", "Diagram rendering was cancelled.")]);
        const choice = this.choice(id, diagram.kind, options.format, requestedAdapterId);
        if (!choice.supported) {
          attempts.push({ adapterId: id, ...(choice.version ? { adapterVersion: choice.version } : {}), status: "unsupported", stage: "selection", issues: [issue("unsupported_adapter", choice.reason ?? "Adapter is unavailable.")] });
          continue;
        }
        const adapter = this.adapters.get(id)!;
        active.adapter = adapter;
        let stage: DiagramRenderAttempt["stage"] = "transform";
        let combinedIssues = projectIssues;
        try {
          // A backend never receives the caller's mutable Project IR or manual-layout object.
          const document = await abortable(adapter.transform(structuredClone(diagram), signal), signal);
          const invalidDocument = documentIssues(document, adapter, diagram);
          if (invalidDocument.length) { attempts.push({ adapterId: id, adapterVersion: adapter.version, status: "failed", stage, issues: invalidDocument }); continue; }
          stage = "validate";
          const adapterReceipt = await abortable(adapter.validate(document, signal), signal);
          combinedIssues = [...projectIssues, ...receiptIssues(adapterReceipt, adapter)];
          if (combinedIssues.some((entry) => entry.severity === "error")) { attempts.push({ adapterId: id, adapterVersion: adapter.version, status: "failed", stage, issues: combinedIssues }); continue; }
          stage = "render";
          const renderOptions = { ...(options.format ? { format: options.format } : {}), operationId, signal, ...(options.destination ? { destination: options.destination } : {}), ...(options.layoutOverlay ? { layoutOverlay: structuredClone(options.layoutOverlay) } : {}) };
          const artifact = await abortable(adapter[mode](document, renderOptions), signal);
          stage = "artifact";
          const invalidArtifact = artifactIssues(artifact, adapter, diagram, options.format);
          if (invalidArtifact.length) { attempts.push({ adapterId: id, adapterVersion: adapter.version, status: "failed", stage, issues: invalidArtifact }); continue; }
          const validation = receipt(adapter.id, adapter.version, combinedIssues);
          const snapshot = createDiagramSnapshot(diagram, artifact, validation, { ...(options.layoutOverlay ? { layoutOverlay: options.layoutOverlay } : {}) });
          attempts.push({ adapterId: id, adapterVersion: adapter.version, status: "rendered", stage, issues: combinedIssues });
          return { status: "rendered", diagramId: diagram.id, ...(requestedAdapterId ? { requestedAdapterId } : {}), adapterId: id, artifact: structuredClone(artifact), snapshot, receipt: validation, attempts, fallback: id !== selectedIds[0], usedLastGood: false };
        } catch (error) {
          if (signal.aborted || error instanceof DiagramRenderCancelled) {
            const issues = [...combinedIssues, issue("cancelled", "Diagram rendering was cancelled.")];
            attempts.push({ adapterId: id, adapterVersion: adapter.version, status: "cancelled", stage, issues });
            return failure("cancelled", issues);
          }
          attempts.push({ adapterId: id, adapterVersion: adapter.version, status: "failed", stage, issues: [...combinedIssues, issue("adapter_failed", `Adapter '${id}' failed during ${stage}: ${errorMessage(error)}`)] });
        }
      }
      return failure("failed", [...projectIssues, ...attempts.flatMap((attempt) => attempt.issues), ...(attempts.length ? [] : [issue("no_adapter", "No diagram adapter is available.")])]);
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (this.active.get(operationId) === active) this.active.delete(operationId);
    }
  }

  cancel(operationId: string): void {
    const active = this.active.get(operationId);
    if (!active || active.controller.signal.aborted) return;
    active.controller.abort();
    try { active.adapter?.cancel?.(operationId); } catch { /* A broken backend cancellation hook must not prevent host cancellation. */ }
  }

  dispose(): void {
    this.disposed = true;
    for (const operationId of this.active.keys()) this.cancel(operationId);
    for (const adapter of this.adapters.values()) { try { adapter.dispose(); } catch { /* Dispose the remaining adapters even if one backend fails. */ } }
    this.adapters.clear();
  }
}
