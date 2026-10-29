import { z } from "zod";
import { projectContentHash } from "./projectHash.js";
export { projectContentHash } from "./projectHash.js";
import { ProjectModelStore, type ProjectDocumentUpdate } from "./projectModelStore.js";
import type { ProjectModel } from "../../contracts/projectModel.js";
import { projectModelIntent } from "../../knowledge/projectModel.js";
import type { ProjectEvidenceSummary } from "../../contracts/evidence.js";
import { validateProjectDiagram, type ProjectDiagram } from "../../contracts/projectDiagram.js";
import { projectEvidenceSettingsSchema } from "../../contracts/projectEvidenceSettings.js";
import { projectIntentSchema, validateProjectIntent, type ProjectIntent } from "../../contracts/projectIntent.js";
import { normalizeProjectObject, type ProjectObject } from "../../contracts/projectKnowledge.js";
import { projectToolSettingsSchema, projectWorkspaceSettingsSchema } from "../../contracts/projectSettings.js";
import type { ProjectDiagramHistoryState } from "../../knowledge/projectDiagramHistory.js";

/**
 * Long-term project files live under `.dext/` and are deliberately separate from conversation
 * snapshots. Cleaning a conversation therefore never touches formal knowledge.
 */
export const PROJECT_DEFINITION_PATH = ".dext/project.json";
export const PROJECT_ARCHITECTURE_PATH = ".dext/architecture.json";
export const PROJECT_INTENT_PATH = ".dext/project-intent.json";
export const PROJECT_DIAGRAM_HISTORY_PATH = ".dext/diagram-history.json";
export const PROJECT_DIAGRAMS_DIRECTORY = ".dext/diagrams";
/** What the last evidence read handed to the model, so a later diagram can be explained. */
export const PROJECT_EVIDENCE_PATH = ".dext/evidence.json";

export function projectDiagramPath(id: string): string {
  return `${PROJECT_DIAGRAMS_DIRECTORY}/${encodeURIComponent(id)}.json`;
}

export const projectKnowledgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  initialized: z.boolean().default(false)
}).passthrough();
export type ProjectKnowledgeConfig = z.infer<typeof projectKnowledgeConfigSchema>;

export const projectDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().nonnegative().default(0),
  knowledge: projectKnowledgeConfigSchema.default({ enabled: false, initialized: false }),
  evidence: projectEvidenceSettingsSchema.optional(),
  /** Host-owned Agent tools; absent keeps the default enabled behavior. */
  tool: projectToolSettingsSchema.optional(),
  /** Project-owned resource and plan paths. */
  paths: projectWorkspaceSettingsSchema.optional(),
  /** Project-only AI CLI. Omitted means use the current Input selection. */
  /** Project-only Agent CLI and optional model override. */
  ai: z.object({
    cli: z.enum(["codex", "claude", "deepseek-harness", "pi"]).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
    speed: z.string().min(1).optional()
  }).passthrough().default({}),
  updatedAt: z.number().int().nonnegative().default(0)
})
  // Preserve legacy and unknown fields as inactive data without generating them.
  .passthrough();
export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;

export const projectArchitectureRuleSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["allow", "deny", "no_cycles"]),
  /** Stable Project node id from the saved diagram; `*` is accepted by `no_cycles`. */
  from: z.string().min(1),
  to: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
}).strict();

export const projectArchitectureSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().nonnegative().default(0),
  decisions: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), detail: z.string().default("") }).strict()).default([]),
  /** Diagram the declared rules were authored against; omitted selects the only architecture diagram. */
  diagramId: z.string().min(1).optional(),
  /** Declared architecture rules over stable Project node ids. */
  rules: z.array(projectArchitectureRuleSchema).default([]),
  updatedAt: z.number().int().nonnegative().default(0)
}).strict();
export type ProjectArchitectureDocument = z.infer<typeof projectArchitectureSchema>;

/**
 * The evidence record is a diagnostic, not knowledge: it stays readable when a field is unknown and
 * a damaged file must never block initialization or diagram generation.
 */
export const projectEvidenceSummarySchema = z.object({
  version: z.literal(1),
  trigger: z.enum(["initialize", "diagram"]),
  generatedAt: z.number().int().nonnegative(),
  inputHash: z.string(),
  structure: z.object({
    files: z.number().int().nonnegative(), parsed: z.number().int().nonnegative(), cached: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative(), modules: z.number().int().nonnegative()
  }).passthrough().optional(),
  structureIndex: z.object({
    hash: z.string().optional(), files: z.number().int().nonnegative(), parsed: z.number().int().nonnegative(),
    modules: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), unsupported: z.number().int().nonnegative()
  }).passthrough().optional(),
  selection: z.object({
    scope: z.array(z.string()).default([]),
    preset: z.string().optional(),
    files: z.number().int().nonnegative(),
    fileChars: z.number().int().nonnegative(),
    evidenceChars: z.number().int().nonnegative()
  }).passthrough(),
  inventory: z.object({ total: z.number().int().nonnegative(), withSymbols: z.number().int().nonnegative(), byKind: z.record(z.string(), z.number().int().nonnegative()).default({}) }).passthrough(),
  excerpts: z.object({ total: z.number().int().nonnegative(), truncated: z.number().int().nonnegative(), byKind: z.record(z.string(), z.number().int().nonnegative()).default({}) }).passthrough(),
  omitted: z.object({ files: z.number().int().nonnegative(), objects: z.number().int().nonnegative(), knowledge: z.number().int().nonnegative() }),
  coverage: z.array(z.string()).default([]),
  paths: z.array(z.string()).default([]),
  excerpted: z.array(z.string()).default([])
}).passthrough();

export function defaultProjectDefinition(now = Date.now()): ProjectDefinition {
  return { schemaVersion: 1, version: 0, knowledge: { enabled: false, initialized: false }, ai: {}, updatedAt: now };
}

/** Minimal file host so the store works with VS Code, a worker, or an in-memory test double. */
export interface ProjectFileHost {
  readFile(relativePath: string): Promise<string | undefined>;
  writeFile(relativePath: string, content: string): Promise<void>;
  listDirectory(relativeDir: string): Promise<string[]>;
  /** Missing files return undefined; all other failures must be propagated. */
  readFileStrict?(relativePath: string): Promise<string | undefined>;
  listDirectoryStrict?(relativeDir: string): Promise<string[]>;
  deleteFile?(relativePath: string): Promise<void>;
}

export interface ProjectLegacySnapshot {
  diagram?: ProjectDiagram;
  intent?: ProjectIntent;
  objects: ProjectObject[];
  architecture?: ProjectArchitectureDocument;
  files: Array<{ path: string; raw: string; hash: string }>;
}

export type ProjectSaveResult<T> =
  | { status: "applied"; value: T }
  | { status: "conflict"; current: T };

export interface ProjectSaveOptions {
  now?: number;
}

/**
 * Owns only the long-lived project files: settings, accepted objects, and declared architecture.
 */
export class ProjectStore {
  constructor(private readonly host: ProjectFileHost) {}

  readModel(): Promise<ProjectModel | undefined> { return new ProjectModelStore(this.host).read(); }
  private nativeStore: ProjectModelStore | undefined;
  updateProject(next: ProjectModel, expectedRevision: number | null, documents: readonly ProjectDocumentUpdate[] = []): Promise<ProjectModel> {
    this.nativeStore ??= new ProjectModelStore(this.host);
    return this.nativeStore.update(next, expectedRevision, documents);
  }

  async readStrict(path: string): Promise<string | undefined> {
    return this.host.readFileStrict ? this.host.readFileStrict(path) : this.host.readFile(path);
  }

  async listStrict(path: string): Promise<string[]> {
    return this.host.listDirectoryStrict ? this.host.listDirectoryStrict(path) : this.host.listDirectory(path);
  }

  /** The Plan path must distinguish absent data from damaged or inaccessible norms. */
  async readLegacySnapshot(validateRelations = true): Promise<ProjectLegacySnapshot> {
    if (await this.readModel()) throw new Error("Native Project is authoritative; legacy snapshot is disabled.");
    const snapshot: ProjectLegacySnapshot = { objects: [], files: [] };
    const read = async (path: string): Promise<unknown> => {
      const raw = await this.readStrict(path);
      if (raw === undefined) return undefined;
      snapshot.files.push({ path, raw, hash: projectContentHash(raw) });
      return JSON.parse(raw) as unknown;
    };
    const intent = await read(PROJECT_INTENT_PATH);
    if (intent !== undefined) {
      snapshot.intent = projectIntentSchema.parse(intent);
      const errors = validateProjectIntent(snapshot.intent);
      if (errors.length) throw new Error(errors.map(error => error.message).join(" "));
    }
    const architecture = await read(PROJECT_ARCHITECTURE_PATH);
    if (architecture !== undefined) snapshot.architecture = projectArchitectureSchema.parse(architecture);
    const names = this.host.listDirectoryStrict ? await this.host.listDirectoryStrict(".dext/objects") : await this.host.listDirectory(".dext/objects");
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      if (/[\\/]/.test(name) || name === "..") throw new Error("Invalid Project object file name.");
      const object = await read(`.dext/objects/${name}`);
      if (object === undefined) throw new Error(`Project object '${name}' disappeared during reading.`);
      snapshot.objects.push(normalizeProjectObject(object));
    }
    const ids = new Set(snapshot.objects.map(object => object.id));
    if (ids.size !== snapshot.objects.length) throw new Error("Duplicate Project object IDs.");
    for (const object of snapshot.objects) for (const id of validateRelations ? object.relatedIds : []) {
      if (!ids.has(id)) throw new Error(`Project object '${object.id}' references missing object '${id}'.`);
    }
    if (snapshot.architecture?.rules.length) {
      const diagrams = await this.readDiagrams();
      const diagram = snapshot.architecture.diagramId
        ? diagrams.find(item => item.id === snapshot.architecture!.diagramId)
        : diagrams.filter(item => item.kind === "architecture").length === 1 ? diagrams.find(item => item.kind === "architecture") : undefined;
      if (!diagram) throw new Error("Architecture rules have no unambiguous saved diagram.");
      const diagramRaw = await read(projectDiagramPath(diagram.id));
      if (diagramRaw === undefined) throw new Error("Architecture diagram disappeared during reading.");
      const savedDiagram = diagramRaw as ProjectDiagram;
      if (validateProjectDiagram(savedDiagram).some(issue => issue.severity === "error")) throw new Error("Architecture diagram is invalid.");
      snapshot.diagram = savedDiagram;
      const nodes = new Set(diagram.nodes.map(node => node.id));
      for (const rule of snapshot.architecture.rules) {
        if ((rule.from !== "*" && !nodes.has(rule.from)) || (rule.to !== undefined && !nodes.has(rule.to))) throw new Error(`Architecture rule '${rule.id}' has a missing endpoint.`);
      }
    }
    return snapshot;
  }

  /** Hash guards protect external editors as well as other in-process callers. */
  async writeLegacyChecked(path: string, value: unknown, expectedHash: string | null): Promise<"applied" | "conflict"> {
    if (await this.readModel()) throw new Error("Native Project is authoritative; legacy writes are disabled.");
    let parsed: unknown;
    if (path === PROJECT_INTENT_PATH) {
      parsed = projectIntentSchema.parse(value);
      const errors = validateProjectIntent(parsed as ProjectIntent);
      if (errors.length) throw new Error(errors.map(error => error.message).join(" "));
    } else if (path === PROJECT_ARCHITECTURE_PATH) parsed = projectArchitectureSchema.parse(value);
    else if (/^\.dext\/objects\/[^/\\]+\.json$/.test(path)) parsed = normalizeProjectObject(value);
    else throw new Error("Unsupported Project write target.");
    const current = await this.readStrict(path);
    if ((current === undefined ? null : projectContentHash(current)) !== expectedHash) return "conflict";
    await this.host.writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`);
    return "applied";
  }

  async deleteLegacyChecked(path: string, expectedHash: string): Promise<"applied" | "conflict"> {
    if (await this.readModel()) throw new Error("Native Project is authoritative; legacy writes are disabled.");
    if (!/^\.dext\/objects\/[^/\\]+\.json$/.test(path)) throw new Error("Only an explicit legacy object may be deleted.");
    if (!this.host.deleteFile) throw new Error("Project deletion is unavailable.");
    const current = await this.readStrict(path);
    if (current === undefined || projectContentHash(current) !== expectedHash) return "conflict";
    await this.host.deleteFile(path);
    return "applied";
  }

  async readDefinition(): Promise<ProjectDefinition> {
    const raw = await this.host.readFile(PROJECT_DEFINITION_PATH);
    if (!raw) return defaultProjectDefinition();
    try {
      return projectDefinitionSchema.parse(JSON.parse(raw));
    } catch {
      // A corrupt or future-schema file must not block development; fall back to defaults.
      return defaultProjectDefinition();
    }
  }

  async writeDefinition(next: ProjectDefinition, expectedVersion: number, options: ProjectSaveOptions = {}): Promise<ProjectSaveResult<ProjectDefinition>> {
    const current = await this.readDefinition();
    if (current.version !== expectedVersion) return { status: "conflict", current };
    const value = projectDefinitionSchema.parse({ ...next, version: current.version + 1, updatedAt: options.now ?? Date.now() });
    await this.host.writeFile(PROJECT_DEFINITION_PATH, `${JSON.stringify(value, null, 2)}\n`);
    return { status: "applied", value };
  }

  async readIntent(): Promise<ProjectIntent | undefined> {
    const native = await this.readModel();
    if (native) {
      const documents = new Map<string, string>();
      for (const node of native.nodes) if (node.body.kind === "document") {
        const content = await this.readStrict(node.body.path);
        if (content !== undefined) documents.set(node.body.path, content);
      }
      return projectModelIntent(native, documents);
    }
    const raw = await this.host.readFile(PROJECT_INTENT_PATH);
    if (!raw) return undefined;
    try { return projectIntentSchema.parse(JSON.parse(raw)); } catch { return undefined; }
  }

  /** The last evidence record. `undefined` means the guess-and-check file is missing or damaged. */
  async readEvidenceSummary(): Promise<ProjectEvidenceSummary | undefined> {
    const raw = await this.host.readFile(PROJECT_EVIDENCE_PATH);
    if (!raw) return undefined;
    try { return projectEvidenceSummarySchema.parse(JSON.parse(raw)) as ProjectEvidenceSummary; } catch { return undefined; }
  }

  async writeEvidenceSummary(summary: ProjectEvidenceSummary): Promise<void> {
    await this.host.writeFile(PROJECT_EVIDENCE_PATH, `${JSON.stringify(projectEvidenceSummarySchema.parse(summary), null, 2)}\n`);
  }

  async writeIntent(intent: ProjectIntent): Promise<void> {
    if (await this.readModel()) throw new Error("Native Project is authoritative; use updateProject.");
    await this.host.writeFile(PROJECT_INTENT_PATH, `${JSON.stringify(projectIntentSchema.parse(intent), null, 2)}\n`);
  }

  /**
   * The raw `.dext/diagram-history.json` document. It stays raw so the diagram registry can validate
   * and import it itself; a damaged file reports `undefined` instead of erasing live last-good state.
   */
  async readDiagramHistoryState(): Promise<unknown> {
    const raw = await this.host.readFile(PROJECT_DIAGRAM_HISTORY_PATH);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as unknown; } catch { return undefined; }
  }

  async writeDiagramHistoryState(state: ProjectDiagramHistoryState): Promise<void> {
    await this.host.writeFile(PROJECT_DIAGRAM_HISTORY_PATH, `${JSON.stringify(state, null, 2)}\n`);
  }

  /**
   * Restores initialization state from persisted data. A legacy flag or leftover scan data alone
   * never counts as success; only a valid intent/diagram makes the knowledge model usable.
   */
  async readInitialization(): Promise<{ markedInitialized: boolean; hasIntent: boolean; diagramCount: number }> {
    const [definition, intent, diagrams] = await Promise.all([this.readDefinition(), this.readIntent(), this.readDiagrams()]);
    return { markedInitialized: definition.knowledge.initialized, hasIntent: intent !== undefined, diagramCount: diagrams.length };
  }

  async readDiagrams(): Promise<ProjectDiagram[]> {
    const names = await this.host.listDirectory(PROJECT_DIAGRAMS_DIRECTORY);
    const diagrams: ProjectDiagram[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const raw = await this.host.readFile(`${PROJECT_DIAGRAMS_DIRECTORY}/${name}`);
      if (!raw) continue;
      try {
        const diagram = JSON.parse(raw) as ProjectDiagram;
        if (diagram.schemaVersion !== 1 || !diagram.id || validateProjectDiagram(diagram).some((issue) => issue.severity === "error")) continue;
        diagrams.push(diagram);
      } catch { /* Ignore a damaged diagram; other project knowledge remains usable. */ }
    }
    return diagrams.sort((left, right) => left.id.localeCompare(right.id));
  }

  async writeDiagram(diagram: ProjectDiagram): Promise<void> {
    if (diagram.schemaVersion !== 1 || validateProjectDiagram(diagram).some((issue) => issue.severity === "error")) {
      throw new Error(`Invalid project diagram '${diagram.id}'.`);
    }
    await this.host.writeFile(projectDiagramPath(diagram.id), `${JSON.stringify(diagram, null, 2)}\n`);
  }

  async readObjects(): Promise<ProjectObject[]> {
    const native = await this.readModel();
    if (native) return native.nodes.filter(node => ["module", "feature", "concept"].includes(node.kind)).map(node => normalizeProjectObject({
      id: node.id, canonicalName: /^[A-Za-z][A-Za-z0-9._-]*$/.test(node.canonicalName) ? node.canonicalName : `Node-${projectContentHash(node.id).slice(0, 10)}`,
      displayName: node.title, kind: node.kind, description: node.body.kind === "inline" ? node.body.text : `Document: ${node.body.path}`, paths: node.paths,
      relatedIds: native.relations.filter(edge => edge.from === node.id && edge.kind === "related_to").map(edge => edge.to),
      source: node.origin === "declared" ? "user" : "ai", confirmation: node.review === "edited" ? "accepted" : node.review, validity: node.freshness, evidence: node.evidence
    }));
    const names = await this.host.listDirectory(".dext/objects");
    const objects: ProjectObject[] = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const raw = await this.host.readFile(`.dext/objects/${name}`);
      if (!raw) continue;
      try {
        objects.push(normalizeProjectObject(JSON.parse(raw)));
      } catch {
        // Unreadable accepted objects are skipped rather than deleting the file.
      }
    }
    return objects.sort((left, right) => left.id.localeCompare(right.id));
  }

  async readArchitecture(): Promise<ProjectArchitectureDocument> {
    const native = await this.readModel();
    const endpoint = (id: string, role: string) => {
      const edge = native?.relations.find(edge => edge.from === id && edge.kind === "constrains" && edge.description === role);
      const node = native?.nodes.find(node => node.id === edge?.to);
      return node?.properties.legacyNodeId ?? node?.id;
    };
    if (native) return projectArchitectureSchema.parse({ schemaVersion: 1, version: native.revision, updatedAt: native.updatedAt,
      diagramId: native.nodes.find(node => node.properties.legacyScope === "architecture" && node.properties.diagramId)?.properties.diagramId,
      decisions: native.nodes.filter(node => node.kind === "decision").map(node => ({ id: node.id, title: node.title, detail: node.body.kind === "inline" ? node.body.text : node.body.path })),
      rules: native.nodes.filter(node => node.kind === "constraint" && node.properties.legacyScope === "architecture").map(node => ({ id: node.id, type: node.properties.type, from: node.properties.wildcardFrom ? "*" : endpoint(node.id, "from"), ...(endpoint(node.id, "to") ? { to: endpoint(node.id, "to") } : {}), reason: node.body.kind === "inline" ? node.body.text : node.body.path }))
    });
    const raw = await this.host.readFile(PROJECT_ARCHITECTURE_PATH);
    if (!raw) return { schemaVersion: 1, version: 0, decisions: [], rules: [], updatedAt: 0 };
    try {
      return projectArchitectureSchema.parse(JSON.parse(raw));
    } catch {
      // A rule typo must be visible rather than silently ignored, but it must not take the decisions
      // with it: the caller reports a damaged file and the defaults keep the page readable.
      return { schemaVersion: 1, version: 0, decisions: [], rules: [], updatedAt: 0 };
    }
  }

  async writeArchitecture(next: ProjectArchitectureDocument, expectedVersion: number, options: ProjectSaveOptions = {}): Promise<ProjectSaveResult<ProjectArchitectureDocument>> {
    if (await this.readModel()) throw new Error("Native Project is authoritative; edit its nodes and relationships instead.");
    const current = await this.readArchitecture();
    if (current.version !== expectedVersion) return { status: "conflict", current };
    const value = projectArchitectureSchema.parse({ ...next, version: current.version + 1, updatedAt: options.now ?? Date.now() });
    await this.host.writeFile(PROJECT_ARCHITECTURE_PATH, `${JSON.stringify(value, null, 2)}\n`);
    return { status: "applied", value };
  }
}
