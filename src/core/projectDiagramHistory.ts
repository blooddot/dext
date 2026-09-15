import type { DiagramAdapterArtifact } from "./projectDiagramAdapter.js";
import { validateProjectDiagram, type DiagramValidationIssue, type DiagramValidationReceipt, type ProjectDiagram, type ProjectDiagramEvidence, type ProjectDiagramLayoutOverlay } from "./projectDiagram.js";

/** Geometry reported by a renderer, separate from a user's manual layout overlay. */
export interface ProjectDiagramRenderedLayout {
  nodes: Readonly<Record<string, { x: number; y: number; width?: number; height?: number }>>;
  routes?: Readonly<Record<string, readonly { x: number; y: number }[]>>;
}

export interface ProjectDiagramSnapshot {
  diagram: ProjectDiagram;
  artifact: DiagramAdapterArtifact;
  receipt: DiagramValidationReceipt;
  renderedAt: number;
  /** User-authored coordinates belong to a render snapshot, never the semantic IR. */
  layoutOverlay?: ProjectDiagramLayoutOverlay;
  renderedLayout?: ProjectDiagramRenderedLayout;
}

export interface DiagramEntityDelta {
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
}

export interface DiagramEvidenceDelta {
  entity: "node" | "relation";
  id: string;
  before: readonly ProjectDiagramEvidence[];
  after: readonly ProjectDiagramEvidence[];
}

export interface DiagramLayoutDelta {
  nodes: DiagramEntityDelta;
  routes: DiagramEntityDelta;
  /** A missing geometry report is not evidence that a layout did not change. */
  comparable: boolean;
}

export interface ProjectDiagramDelta {
  semantic: {
    nodes: DiagramEntityDelta;
    relations: DiagramEntityDelta;
    titleChanged: boolean;
    kindChanged: boolean;
    metadataChanged: boolean;
  };
  evidence: readonly DiagramEvidenceDelta[];
  manualLayout: DiagramLayoutDelta & { adapterChanged: boolean };
  renderedLayout: DiagramLayoutDelta;
  artifact: {
    contentChanged: boolean;
    formatChanged: boolean;
    mimeTypeChanged: boolean;
    adapterChanged: boolean;
    adapterVersionChanged: boolean;
  };
  changed: boolean;
}

export interface ProjectDiagramComparison {
  before?: ProjectDiagramSnapshot;
  delta: ProjectDiagramDelta;
  after: ProjectDiagramSnapshot;
}

export interface ProjectDiagramHistoryEntry {
  diagramId: string;
  lastGood: ProjectDiagramSnapshot;
  previous?: ProjectDiagramSnapshot;
  versions: readonly ProjectDiagramSnapshot[];
  lastFailure?: DiagramValidationReceipt;
}

interface SerializedDiagramSnapshot extends Omit<ProjectDiagramSnapshot, "artifact"> {
  artifact: Omit<DiagramAdapterArtifact, "content"> & {
    content: { encoding: "text"; value: string } | { encoding: "bytes"; value: number[] };
  };
}

/** JSON-safe history, including PNG bytes. Runtime AbortSignals or adapter objects never enter storage. */
export interface ProjectDiagramHistoryState {
  schemaVersion: 1;
  entries: {
    diagramId: string;
    versions: SerializedDiagramSnapshot[];
    lastFailure?: DiagramValidationReceipt;
  }[];
}

/** Stable JSON equality ignores property insertion order, while preserving meaningful array order. */
function stable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value instanceof Uint8Array) return JSON.stringify([...value]);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function entityDelta<T>(before: Readonly<Record<string, T>>, after: Readonly<Record<string, T>>): DiagramEntityDelta {
  const beforeIds = Object.keys(before);
  const afterIds = Object.keys(after);
  return {
    added: afterIds.filter((id) => !Object.hasOwn(before, id)).sort(),
    removed: beforeIds.filter((id) => !Object.hasOwn(after, id)).sort(),
    changed: afterIds.filter((id) => Object.hasOwn(before, id) && stable(before[id]) !== stable(after[id])).sort()
  };
}

function indexed<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

function semanticItems<T extends { id: string; evidence: readonly ProjectDiagramEvidence[] }>(items: readonly T[]): Record<string, Omit<T, "evidence">> {
  return Object.fromEntries(items.map((item) => {
    const { evidence: _evidence, ...semantic } = item;
    void _evidence;
    return [item.id, semantic];
  }));
}

function evidenceChanges(entity: DiagramEvidenceDelta["entity"], before: readonly { id: string; evidence: readonly ProjectDiagramEvidence[] }[], after: readonly { id: string; evidence: readonly ProjectDiagramEvidence[] }[]): DiagramEvidenceDelta[] {
  const previous = indexed(before);
  const next = indexed(after);
  return [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort().flatMap((id) => {
    const left = previous[id]?.evidence ?? [];
    const right = next[id]?.evidence ?? [];
    // Evidence order does not change the facts it cites.
    return stable(left.map(stable).sort()) === stable(right.map(stable).sort()) ? [] : [{ entity, id, before: left, after: right }];
  });
}

function layoutDelta(before: ProjectDiagramRenderedLayout | undefined, after: ProjectDiagramRenderedLayout | undefined): DiagramLayoutDelta {
  return {
    nodes: entityDelta(before?.nodes ?? {}, after?.nodes ?? {}),
    routes: entityDelta(before?.routes ?? {}, after?.routes ?? {}),
    comparable: before !== undefined && after !== undefined
  };
}

function hasEntityChanges(delta: DiagramEntityDelta): boolean {
  return delta.added.length + delta.removed.length + delta.changed.length > 0;
}

/** Compares semantic, evidence and presentation changes independently using stable Project ids. */
export function compareDiagramSnapshots(before: ProjectDiagramSnapshot | undefined, after: ProjectDiagramSnapshot): ProjectDiagramComparison {
  if (before && before.diagram.id !== after.diagram.id) throw new Error("Cannot compare snapshots of different Project diagrams.");
  const semantic = {
    nodes: entityDelta(semanticItems(before?.diagram.nodes ?? []), semanticItems(after.diagram.nodes)),
    relations: entityDelta(semanticItems(before?.diagram.relations ?? []), semanticItems(after.diagram.relations)),
    titleChanged: before?.diagram.title !== after.diagram.title,
    kindChanged: before?.diagram.kind !== after.diagram.kind,
    metadataChanged: stable(before?.diagram.metadata) !== stable(after.diagram.metadata)
  };
  const evidence = [
    ...evidenceChanges("node", before?.diagram.nodes ?? [], after.diagram.nodes),
    ...evidenceChanges("relation", before?.diagram.relations ?? [], after.diagram.relations)
  ];
  const manualLayout = {
    ...layoutDelta(before?.layoutOverlay, after.layoutOverlay),
    adapterChanged: before?.layoutOverlay?.adapterId !== after.layoutOverlay?.adapterId
  };
  const renderedLayout = layoutDelta(before?.renderedLayout, after.renderedLayout);
  const artifact = {
    contentChanged: stable(before?.artifact.content) !== stable(after.artifact.content),
    formatChanged: before?.artifact.format !== after.artifact.format,
    mimeTypeChanged: before?.artifact.mimeType !== after.artifact.mimeType,
    adapterChanged: before?.artifact.adapterId !== after.artifact.adapterId,
    adapterVersionChanged: before?.artifact.adapterVersion !== after.artifact.adapterVersion
  };
  const changed = hasEntityChanges(semantic.nodes) || hasEntityChanges(semantic.relations)
    || semantic.titleChanged || semantic.kindChanged || semantic.metadataChanged || evidence.length > 0
    || hasEntityChanges(manualLayout.nodes) || hasEntityChanges(manualLayout.routes) || manualLayout.adapterChanged
    || hasEntityChanges(renderedLayout.nodes) || hasEntityChanges(renderedLayout.routes)
    || Object.values(artifact).some(Boolean);
  return { ...(before ? { before: structuredClone(before) } : {}), delta: { semantic, evidence, manualLayout, renderedLayout, artifact, changed }, after: structuredClone(after) };
}

/** Alias for consumers displaying Before / Delta / After. */
export const diffProjectDiagrams = compareDiagramSnapshots;

/** A failed receipt or mismatched artifact cannot be promoted, even if the caller bypassed a registry. */
export function isUsableDiagramSnapshot(snapshot: ProjectDiagramSnapshot): boolean {
  try {
    return Boolean(snapshot.diagram.id)
      && snapshot.diagram.schemaVersion === 1
      && Number.isInteger(snapshot.diagram.version) && snapshot.diagram.version >= 0
      && Number.isFinite(snapshot.renderedAt) && snapshot.renderedAt >= 0
      && snapshot.artifact.diagramId === snapshot.diagram.id
      && snapshot.artifact.adapterId === snapshot.receipt.adapterId
      && snapshot.artifact.adapterVersion === snapshot.receipt.adapterVersion
      && (snapshot.receipt.status === "passed" || snapshot.receipt.status === "warning")
      && Array.isArray(snapshot.receipt.issues)
      && snapshot.receipt.issues.every((entry: DiagramValidationIssue) => ["info", "warning"].includes(entry.severity))
      && (typeof snapshot.artifact.content === "string" || snapshot.artifact.content instanceof Uint8Array)
      && snapshot.artifact.content.length > 0
      && validateProjectDiagram(snapshot.diagram).every((issue) => issue.severity !== "error");
  } catch { return false; }
}

export function createDiagramSnapshot(diagram: ProjectDiagram, artifact: DiagramAdapterArtifact, receipt: DiagramValidationReceipt, options: { renderedAt?: number; renderedLayout?: ProjectDiagramRenderedLayout; layoutOverlay?: ProjectDiagramLayoutOverlay } = {}): ProjectDiagramSnapshot {
  const snapshot: ProjectDiagramSnapshot = { diagram, artifact, receipt, renderedAt: options.renderedAt ?? Date.now(), ...(options.renderedLayout ? { renderedLayout: options.renderedLayout } : {}), ...(options.layoutOverlay ? { layoutOverlay: options.layoutOverlay } : {}) };
  if (!isUsableDiagramSnapshot(snapshot)) throw new Error("Only a validated diagram and matching artifact can become last-good.");
  return structuredClone(snapshot);
}

function semanticVersionContent(diagram: ProjectDiagram): string {
  const { updatedAt: _updatedAt, review: _review, freshness: _freshness, confidence: _confidence, ...content } = diagram;
  void _updatedAt; void _review; void _freshness; void _confidence;
  return stable(content);
}

function serialized(snapshot: ProjectDiagramSnapshot): SerializedDiagramSnapshot {
  return { ...structuredClone(snapshot), artifact: { ...snapshot.artifact, content: typeof snapshot.artifact.content === "string" ? { encoding: "text", value: snapshot.artifact.content } : { encoding: "bytes", value: [...snapshot.artifact.content] } } };
}

function deserialized(input: unknown): ProjectDiagramSnapshot {
  if (!input || typeof input !== "object") throw new Error("Invalid diagram history snapshot.");
  const stored = input as SerializedDiagramSnapshot;
  const encoded = stored.artifact?.content;
  if (!encoded || (encoded.encoding !== "text" && encoded.encoding !== "bytes")) throw new Error("Invalid stored diagram artifact encoding.");
  if (encoded.encoding === "text" && typeof encoded.value !== "string") throw new Error("Invalid stored text artifact.");
  if (encoded.encoding === "bytes" && (!Array.isArray(encoded.value) || encoded.value.some((value) => !Number.isInteger(value) || value < 0 || value > 255))) throw new Error("Invalid stored binary artifact.");
  const snapshot = { ...stored, artifact: { ...stored.artifact, content: encoded.encoding === "text" ? encoded.value : Uint8Array.from(encoded.value) } };
  if (!isUsableDiagramSnapshot(snapshot)) throw new Error("Invalid diagram history snapshot.");
  return structuredClone(snapshot);
}

function isReceipt(value: unknown): value is DiagramValidationReceipt {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const issues = record["issues"];
  return typeof record["adapterId"] === "string" && typeof record["adapterVersion"] === "string"
    && (record["status"] === "passed" || record["status"] === "warning" || record["status"] === "failed")
    && typeof record["checkedAt"] === "number" && Number.isFinite(record["checkedAt"])
    && Array.isArray(issues) && issues.every((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const issue = entry as Record<string, unknown>;
      return typeof issue["code"] === "string" && typeof issue["message"] === "string" && (issue["severity"] === "error" || issue["severity"] === "warning" || issue["severity"] === "info");
    });
}

/** Keeps last-good output independently of failed or cancelled replacement attempts. */
export class ProjectDiagramHistory {
  private readonly entries = new Map<string, ProjectDiagramHistoryEntry>();
  constructor(private readonly maxVersions = 10) {
    if (!Number.isInteger(maxVersions) || maxVersions < 1) throw new Error("Diagram history size must be a positive integer.");
  }

  get(diagramId: string): ProjectDiagramHistoryEntry | undefined {
    const entry = this.entries.get(diagramId);
    return entry ? structuredClone(entry) : undefined;
  }

  latest(diagramId: string): ProjectDiagramSnapshot | undefined {
    return this.get(diagramId)?.lastGood;
  }

  record(snapshot: ProjectDiagramSnapshot): ProjectDiagramHistoryEntry {
    if (!isUsableDiagramSnapshot(snapshot)) throw new Error("Invalid diagram output cannot replace last-good.");
    const existing = this.entries.get(snapshot.diagram.id);
    const previous = existing?.lastGood;
    if (previous) {
      if (snapshot.diagram.version < previous.diagram.version || (snapshot.diagram.version === previous.diagram.version && snapshot.renderedAt < previous.renderedAt)) throw new Error("A stale diagram render cannot replace last-good.");
      if (snapshot.diagram.version === previous.diagram.version && semanticVersionContent(snapshot.diagram) !== semanticVersionContent(previous.diagram)) throw new Error("Diagram semantics changed without a version increment.");
    }
    const lastGood = structuredClone(snapshot);
    const entry: ProjectDiagramHistoryEntry = {
      diagramId: snapshot.diagram.id,
      lastGood,
      ...(previous ? { previous: structuredClone(previous) } : {}),
      versions: [...(existing?.versions ?? []), lastGood].slice(-this.maxVersions)
    };
    this.entries.set(entry.diagramId, entry);
    return structuredClone(entry);
  }

  recordFailure(diagramId: string, receipt: DiagramValidationReceipt): void {
    const existing = this.entries.get(diagramId);
    if (existing) this.entries.set(diagramId, { ...existing, lastFailure: structuredClone(receipt) });
  }

  comparison(diagramId: string): ProjectDiagramComparison | undefined {
    const entry = this.entries.get(diagramId);
    return entry ? compareDiagramSnapshots(entry.previous, entry.lastGood) : undefined;
  }

  exportState(): ProjectDiagramHistoryState {
    return {
      schemaVersion: 1,
      entries: [...this.entries.values()].sort((a, b) => a.diagramId.localeCompare(b.diagramId)).map((entry) => ({ diagramId: entry.diagramId, versions: entry.versions.map(serialized), ...(entry.lastFailure ? { lastFailure: structuredClone(entry.lastFailure) } : {}) }))
    };
  }

  /** Validate the entire input before replacing live history. A damaged file cannot erase last-good. */
  importState(input: unknown): void {
    if (!input || typeof input !== "object" || (input as ProjectDiagramHistoryState).schemaVersion !== 1 || !Array.isArray((input as ProjectDiagramHistoryState).entries)) throw new Error("Unsupported diagram history document.");
    const restored = new ProjectDiagramHistory(this.maxVersions);
    const ids = new Set<string>();
    for (const entry of (input as ProjectDiagramHistoryState).entries) {
      if (!entry || typeof entry.diagramId !== "string" || !entry.diagramId || ids.has(entry.diagramId) || !Array.isArray(entry.versions) || entry.versions.length === 0) throw new Error("Invalid diagram history entry.");
      ids.add(entry.diagramId);
      for (const value of entry.versions) {
        const snapshot = deserialized(value);
        if (snapshot.diagram.id !== entry.diagramId) throw new Error("Diagram history entry contains another diagram.");
        restored.record(snapshot);
      }
      if (entry.lastFailure) {
        if (!isReceipt(entry.lastFailure)) throw new Error("Invalid stored diagram failure receipt.");
        restored.recordFailure(entry.diagramId, entry.lastFailure);
      }
    }
    this.entries.clear();
    for (const [id, entry] of restored.entries) this.entries.set(id, entry);
  }
}
