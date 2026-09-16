import { validationStatus, type DiagramValidationIssue, type DiagramValidationReceipt, type ProjectDiagram, type ProjectDiagramKind } from "./projectDiagram.js";
import type { DiagramAdapterArtifact, DiagramAdapterDocument, DiagramAdapterExportOptions, ProjectDiagramAdapter } from "./projectDiagramAdapter.js";
import { ProjectDiagramHistory, createDiagramSnapshot, isArchifySnapshot, type ProjectDiagramSnapshot, type ProjectDiagramHistoryState } from "./projectDiagramHistory.js";

/**
 * Where last-good snapshots survive a window reload. The port carries the raw document so the core
 * registry stays hostless: the extension reads and writes `.dext/diagram-history.json`.
 */
export interface ProjectDiagramHistoryPersistence {
  /** The parsed document, or undefined when nothing was stored (or it is unreadable). */
  load(): Promise<unknown>;
  save(state: ProjectDiagramHistoryState): Promise<void>;
}

/** Persisted artifacts are the last successful render of each diagram; total size stays bounded. */
const MAX_PERSISTED_HISTORY_BYTES = 8 * 1024 * 1024;

export interface ProjectDiagramRenderOptions extends DiagramAdapterExportOptions {
  /** Stable operation id; defaults to the diagram id so a newer render cancels the older one. */
  operationId?: string;
  signal?: AbortSignal;
}

export interface ProjectDiagramEngineInfo {
  id: string;
  version: string;
  available: boolean;
  reason?: string;
}

export interface ProjectDiagramRenderOutcome {
  status: "rendered" | "failed" | "cancelled";
  diagramId: string;
  adapterId?: string;
  artifact?: DiagramAdapterArtifact;
  /** Set when the outcome is a last-good snapshot instead of a fresh render. */
  snapshot?: ProjectDiagramSnapshot;
  /** True when the shown artifact is an older successful render of the same diagram. */
  usedLastGood: boolean;
  /** Semantic version actually shown/exported. Always the version of `artifact`. */
  displayedVersion?: number;
  /** Fresh render succeeded but the adapter reported non-blocking warnings. */
  receipt: DiagramValidationReceipt;
  error?: string;
}

const CANCELLED_CODE = "operation_cancelled";

function failureReceipt(adapterId: string, adapterVersion: string, code: string, message: string): DiagramValidationReceipt {
  return {
    adapterId,
    adapterVersion,
    status: "failed",
    checkedAt: Date.now(),
    issues: [{ code, message, severity: "error" }]
  };
}

/**
 * Owns the single Archify engine, cancellation of stale work, and last-good snapshots.
 * There are deliberately no renderer preferences, recommendations or cross-engine fallbacks.
 */
export class ProjectDiagramAdapterRegistry {
  private adapter: ProjectDiagramAdapter | undefined;
  private readonly active = new Map<string, { controller: AbortController; version: number }>();
  private readonly history = new ProjectDiagramHistory();
  private disposed = false;
  private hydration: Promise<void> | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly persistence?: ProjectDiagramHistoryPersistence) {}

  register(adapter: ProjectDiagramAdapter): void {
    if (this.disposed) throw new Error("Diagram adapter registry has been disposed.");
    if (this.adapter) {
      if (this.adapter.id === adapter.id) throw new Error(`Diagram adapter '${adapter.id}' is already registered.`);
      throw new Error("Project supports exactly one diagram engine.");
    }
    this.adapter = adapter;
  }

  /**
   * Loads last-good snapshots once. A damaged or unsupported document is ignored: `importState`
   * validates the whole file before replacing anything, so a bad file can never erase live history.
   */
  private async hydrate(): Promise<void> {
    const persistence = this.persistence;
    if (!persistence) return;
    this.hydration ??= (async () => {
      try {
        const stored = await persistence.load();
        if (stored !== undefined) this.history.importState(stored);
      } catch { /* an unreadable history only costs the last-good fallback */ }
    })();
    return this.hydration;
  }

  /** Persists the last successful render of every diagram, newest first, within the size budget. */
  private persist(): void {
    const persistence = this.persistence;
    if (!persistence || this.disposed) return;
    const exported = this.history.exportState();
    // Keeping every retained version would write megabytes per diagram, so only the newest snapshot
    // of each diagram is stored; the in-session history still keeps its full version window.
    const entries = exported.entries.map((entry) => ({ ...entry, versions: entry.versions.slice(-1) }));
    const newestFirst = [...entries].sort((left, right) => (right.versions.at(-1)?.renderedAt ?? 0) - (left.versions.at(-1)?.renderedAt ?? 0));
    const kept: typeof entries = [];
    let bytes = 0;
    for (const entry of newestFirst) {
      const size = JSON.stringify(entry).length;
      if (kept.length && bytes + size > MAX_PERSISTED_HISTORY_BYTES) continue;
      kept.push(entry);
      bytes += size;
    }
    const state: ProjectDiagramHistoryState = { schemaVersion: 1, entries: kept.sort((left, right) => left.diagramId.localeCompare(right.diagramId)) };
    // Saves are serialized and never surface: a failed write must not fail the render that triggered it.
    this.saving = this.saving.then(() => persistence.save(state)).catch(() => undefined);
  }

  unregister(id: string): void {
    if (this.adapter?.id !== id) return;
    // Operation ids are `${diagram.id}:${version}`, not adapter-scoped, so every in-flight render
    // belongs to the adapter being removed and must be cancelled with it.
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
    this.adapter.dispose();
    this.adapter = undefined;
  }

  list(): readonly ProjectDiagramAdapter[] {
    return this.adapter ? [this.adapter] : [];
  }

  supports(kind: ProjectDiagramKind): boolean {
    return Boolean(this.adapter?.supports(kind));
  }

  /** Probes the installed engine so the page can distinguish missing runtime from missing AI output. */
  async engineInfo(): Promise<ProjectDiagramEngineInfo> {
    // The host asks for engine info before every render, so last-good is loaded by the time it matters.
    await this.hydrate();
    if (!this.adapter) return { id: "archify", version: "", available: false, reason: "Archify is not registered." };
    const probe = (this.adapter as ProjectDiagramAdapter & { probe?: () => Promise<{ available: boolean; reason?: string }> }).probe;
    if (!probe) return { id: this.adapter.id, version: this.adapter.version, available: true };
    const result = await probe.call(this.adapter);
    return { id: this.adapter.id, version: this.adapter.version, available: result.available, ...(result.reason ? { reason: result.reason } : {}) };
  }

  latest(diagramId: string): ProjectDiagramSnapshot | undefined {
    const snapshot = this.history.latest(diagramId);
    return snapshot && isArchifySnapshot(snapshot) ? snapshot : undefined;
  }

  /** Cancels the in-flight render of one diagram (used when switching diagrams or closing the page). */
  cancel(diagramId: string): void {
    for (const [operationId, active] of this.active) {
      if (operationId === diagramId || operationId.startsWith(`${diagramId}:`)) {
        active.controller.abort();
        this.active.delete(operationId);
      }
    }
  }

  cancelAll(): void {
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
  }

  private ensureAdapter(diagram: ProjectDiagram): ProjectDiagramAdapter {
    if (!this.adapter) throw new Error("Archify is not registered.");
    if (!this.adapter.supports(diagram.kind)) throw new Error(`Archify does not support '${diagram.kind}' diagrams.`);
    return this.adapter;
  }

  private documentIssues(document: DiagramAdapterDocument, adapter: ProjectDiagramAdapter, diagram: ProjectDiagram): DiagramValidationIssue[] {
    if (!document || typeof document !== "object" || document.adapterId !== adapter.id || document.adapterVersion !== adapter.version
      || document.diagramId !== diagram.id || document.kind !== diagram.kind || !("payload" in document)) {
      return [{ code: "invalid_adapter_document", message: `Adapter '${adapter.id}' returned a document with a mismatched identity, version or diagram kind.`, severity: "error" }];
    }
    return [];
  }

  private artifactIssues(artifact: DiagramAdapterArtifact, adapter: ProjectDiagramAdapter, diagram: ProjectDiagram, format?: string): DiagramValidationIssue[] {
    if (!artifact || typeof artifact !== "object" || artifact.adapterId !== adapter.id || artifact.adapterVersion !== adapter.version || artifact.diagramId !== diagram.id) {
      return [{ code: "invalid_artifact_identity", message: `Adapter '${adapter.id}' returned an artifact belonging to a different adapter, version or diagram.`, severity: "error" }];
    }
    const formats = adapter.capabilities.find((capability) => capability.kind === diagram.kind)?.formats ?? [];
    if (!formats.includes(artifact.format) || (format !== undefined && artifact.format !== format)) {
      return [{ code: "invalid_artifact_format", message: `Adapter '${adapter.id}' did not return the requested supported format.`, severity: "error" }];
    }
    const expectedMime = artifact.format === "html" ? "text/html" : "image/svg+xml";
    const mime = typeof artifact.mimeType === "string" ? artifact.mimeType.split(";", 1)[0]!.trim().toLowerCase() : "";
    if (mime !== expectedMime) return [{ code: "invalid_artifact_mime", message: `Adapter '${adapter.id}' returned an incompatible MIME type.`, severity: "error" }];
    if (typeof artifact.content !== "string" || !artifact.content.length) return [{ code: "empty_artifact", message: `Adapter '${adapter.id}' returned an empty or invalid artifact.`, severity: "error" }];
    const bytes = new TextEncoder().encode(artifact.content).byteLength;
    if (bytes > 16 * 1024 * 1024) return [{ code: "artifact_too_large", message: "Diagram output exceeds the 16 MiB artifact limit.", severity: "error" }];
    return [];
  }

  /**
   * Renders one diagram. A newer render of the same diagram cancels the older task, so a late
   * response can never replace the current version. On failure the last-good Archify snapshot of
   * the same diagram is returned (when present) with `displayedVersion` naming what is shown.
   */
  async render(diagram: ProjectDiagram, options: ProjectDiagramRenderOptions = {}): Promise<ProjectDiagramRenderOutcome> {
    const adapter = (() => { try { return this.ensureAdapter(diagram); } catch (error) { return error instanceof Error ? error : new Error(String(error)); } })();
    if (adapter instanceof Error) {
      return { status: "failed", diagramId: diagram.id, usedLastGood: false, receipt: failureReceipt("archify", "", "adapter_unavailable", adapter.message), error: adapter.message };
    }
    const operationId = options.operationId ?? `${diagram.id}:${diagram.version}`;
    this.active.get(operationId)?.controller.abort();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    this.active.set(operationId, { controller, version: diagram.version });
    // Hydration is awaited only after this render is registered, so a cancel that arrives before the
    // first await (the usual case when a user switches diagrams immediately) still reaches it.
    await this.hydrate();
    /** An adapter error may carry structured layout diagnostics; those lines are the only
     * actionable part of the failure, so they are appended to the message the UI shows. */
    const failureMessage = (error: unknown): string => {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostics = (error as { diagnostics?: unknown } | null | undefined)?.diagnostics;
      const lines = Array.isArray(diagnostics) ? diagnostics.filter((line): line is string => typeof line === "string" && line.length > 0) : [];
      return lines.length ? `${message}\n${lines.slice(0, 8).join("\n")}` : message;
    };
    const failure = (error: unknown, code = "render_failed"): ProjectDiagramRenderOutcome => {
      const message = failureMessage(error);
      const lastGood = this.latest(diagram.id);
      if (lastGood) {
        return {
          status: "failed",
          diagramId: diagram.id,
          adapterId: adapter.id,
          artifact: lastGood.artifact,
          snapshot: lastGood,
          usedLastGood: true,
          displayedVersion: lastGood.diagram.version,
          receipt: failureReceipt(adapter.id, adapter.version, code, message),
          error: message
        };
      }
      return { status: "failed", diagramId: diagram.id, adapterId: adapter.id, usedLastGood: false, receipt: failureReceipt(adapter.id, adapter.version, code, message), error: message };
    };
    try {
      const document = await adapter.transform(diagram, controller.signal);
      const documentProblem = this.documentIssues(document, adapter, diagram)[0];
      if (documentProblem) return failure(new Error(documentProblem.message), documentProblem.code);
      const artifact = await adapter.render(document, { format: options.format ?? "html", operationId, signal: controller.signal });
      const artifactProblem = this.artifactIssues(artifact, adapter, diagram, options.format)[0];
      if (artifactProblem) return failure(new Error(artifactProblem.message), artifactProblem.code);
      const receipt = await adapter.validate(document, controller.signal);
      if (receipt.status === "failed") {
        this.history.recordFailure(diagram.id, receipt);
        this.persist();
        throw new Error(receipt.issues.map((issue) => issue.message).join("; ") || "Archify rejected the rendered diagram.");
      }
      const snapshot = createDiagramSnapshot(diagram, artifact, receipt);
      this.history.record(snapshot);
      // Last-good now survives a window reload, so a failed next render can still show it.
      this.persist();
      return { status: "rendered", diagramId: diagram.id, adapterId: adapter.id, artifact, snapshot, usedLastGood: false, displayedVersion: diagram.version, receipt };
    } catch (error) {
      if (controller.signal.aborted) {
        return { status: "cancelled", diagramId: diagram.id, adapterId: adapter.id, usedLastGood: false, receipt: failureReceipt(adapter.id, adapter.version, CANCELLED_CODE, "Diagram rendering was cancelled.") };
      }
      return failure(error);
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (this.active.get(operationId)?.controller === controller) this.active.delete(operationId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancelAll();
    this.adapter?.dispose();
    this.adapter = undefined;
  }
}

export { validationStatus };
