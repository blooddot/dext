import { z } from "zod";
import { projectEvidenceSettingsSchema } from "./core/projectEvidenceSettings.js";
import { projectWorkspaceSettingsSchema } from "./core/projectSettings.js";
import { normalizeProjectObject, projectObjectSchema, type ProjectObject } from "./core/projectKnowledge.js";
import { reviewPresetSchema, type ReviewPreset } from "./core/projectContext.js";
import { projectIntentSchema, type ProjectIntent } from "./core/projectIntent.js";
import type { ProjectDiagramHistoryState } from "./core/projectDiagramHistory.js";
import type { ProjectEvidenceSummary } from "./core/projectAiGeneration.js";
import { validateProjectDiagram, type ProjectDiagram } from "./core/projectDiagram.js";

/**
 * Long-term project files live under `.dext/` and are deliberately separate from conversation
 * snapshots and Review runs. Cleaning a conversation therefore never touches formal knowledge.
 */
export const PROJECT_DEFINITION_PATH = ".dext/project.json";
export const PROJECT_ARCHITECTURE_PATH = ".dext/architecture.json";
export const PROJECT_INTENT_PATH = ".dext/project-intent.json";
export const PROJECT_DIAGRAM_HISTORY_PATH = ".dext/diagram-history.json";
export const PROJECT_DIAGRAMS_DIRECTORY = ".dext/diagrams";
/** What the last evidence read handed to the model, so a later diagram can be explained. */
export const PROJECT_EVIDENCE_PATH = ".dext/evidence.json";

export function projectObjectPath(id: string): string {
  return `.dext/objects/${id}.json`;
}

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
  preset: z.object({ default: reviewPresetSchema.default("engineering") }).strict().default({ default: "engineering" }),
  knowledge: projectKnowledgeConfigSchema.default({ enabled: false, initialized: false }),
  evidence: projectEvidenceSettingsSchema.optional(),
  /** Project-owned paths and the default review emphasis. */
  paths: projectWorkspaceSettingsSchema.omit({ reviewPreset: true }).optional(),
  /** Project-only AI CLI. Omitted means use the current Input selection. */
  /** Project-only Agent CLI and optional model override. */
  ai: z.object({
    cli: z.enum(["codex", "claude", "deepseek-harness"]).optional(),
    model: z.string().min(1).optional(),
    reasoningEffort: z.string().min(1).optional(),
    speed: z.string().min(1).optional()
  }).passthrough().default({}),
  updatedAt: z.number().int().nonnegative().default(0)
})
  // Legacy scan profiles and unknown engine settings stay on disk untouched. The product no longer
  // reads or writes them, and parsing must not fail merely because an old field exists.
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
  return { schemaVersion: 1, version: 0, preset: { default: "engineering" }, knowledge: { enabled: false, initialized: false }, ai: {}, updatedAt: now };
}

/** Minimal file host so the store works with VS Code, a worker, or an in-memory test double. */
export interface ProjectFileHost {
  readFile(relativePath: string): Promise<string | undefined>;
  writeFile(relativePath: string, content: string): Promise<void>;
  deleteFile(relativePath: string): Promise<void>;
  listDirectory(relativeDir: string): Promise<string[]>;
}

export type ProjectSaveResult<T> =
  | { status: "applied"; value: T }
  | { status: "conflict"; current: T };

export interface ProjectSaveOptions {
  now?: number;
}

/**
 * Owns only the long-lived project files: settings, accepted objects, and declared architecture.
 * Run snapshots are managed by the conversation run store (see {@link TurnReviewStore}).
 */
export class ProjectStore {
  /** Last definition value, so a synchronous preset read never blocks a send. */
  private cachedPreset: ReviewPreset = "engineering";

  constructor(private readonly host: ProjectFileHost) {}

  async readDefinition(): Promise<ProjectDefinition> {
    const raw = await this.host.readFile(PROJECT_DEFINITION_PATH);
    if (!raw) return this.remember(defaultProjectDefinition());
    try {
      return this.remember(projectDefinitionSchema.parse(JSON.parse(raw)));
    } catch {
      // A corrupt or future-schema file must not block development; fall back to defaults.
      return this.remember(defaultProjectDefinition());
    }
  }

  private remember(definition: ProjectDefinition): ProjectDefinition {
    this.cachedPreset = definition.preset.default;
    return definition;
  }

  /** The project's default Review preset. Before the first read this is the built-in default. */
  presetDefault(): ReviewPreset {
    return this.cachedPreset;
  }

  async writeDefinition(next: ProjectDefinition, expectedVersion: number, options: ProjectSaveOptions = {}): Promise<ProjectSaveResult<ProjectDefinition>> {
    const current = await this.readDefinition();
    if (current.version !== expectedVersion) return { status: "conflict", current };
    const value = projectDefinitionSchema.parse({ ...next, version: current.version + 1, updatedAt: options.now ?? Date.now() });
    await this.host.writeFile(PROJECT_DEFINITION_PATH, `${JSON.stringify(value, null, 2)}\n`);
    this.remember(value);
    return { status: "applied", value };
  }

  async readPresetDefault(): Promise<ReviewPreset> {
    return (await this.readDefinition()).preset.default;
  }

  async readIntent(): Promise<ProjectIntent | undefined> {
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

  async writeObject(object: ProjectObject): Promise<void> {
    const value = projectObjectSchema.parse(object);
    await this.host.writeFile(projectObjectPath(value.id), `${JSON.stringify(value, null, 2)}\n`);
  }

  async deleteObject(id: string): Promise<void> {
    await this.host.deleteFile(projectObjectPath(id));
  }

  async readArchitecture(): Promise<ProjectArchitectureDocument> {
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
    const current = await this.readArchitecture();
    if (current.version !== expectedVersion) return { status: "conflict", current };
    const value = projectArchitectureSchema.parse({ ...next, version: current.version + 1, updatedAt: options.now ?? Date.now() });
    await this.host.writeFile(PROJECT_ARCHITECTURE_PATH, `${JSON.stringify(value, null, 2)}\n`);
    return { status: "applied", value };
  }
}
