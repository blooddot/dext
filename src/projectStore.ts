import { z } from "zod";
import { normalizeProjectObject, projectObjectSchema, type ProjectObject } from "./core/projectKnowledge.js";
import { reviewPresetSchema, type ReviewPreset } from "./core/projectContext.js";

/**
 * Long-term project files live under `.dext/` and are deliberately separate from conversation
 * snapshots and Review runs. Cleaning a conversation therefore never touches formal knowledge.
 */
export const PROJECT_DEFINITION_PATH = ".dext/project.json";
export const PROJECT_ARCHITECTURE_PATH = ".dext/architecture.json";

export function projectObjectPath(id: string): string {
  return `.dext/objects/${id}.json`;
}

export const projectKnowledgeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  initialized: z.boolean().default(false)
}).strict();

/** Optional scan profile reserved for explicit project-specific scope overrides. */
export const projectScanConfigSchema = z.object({
  roots: z.array(z.string().min(1)).default([]),
  includeTests: z.boolean().default(false),
  extraExcludes: z.array(z.string().min(1)).default([])
}).strict();
export type ProjectKnowledgeConfig = z.infer<typeof projectKnowledgeConfigSchema>;

export const projectDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().nonnegative().default(0),
  preset: z.object({ default: reviewPresetSchema.default("engineering") }).strict().default({ default: "engineering" }),
  knowledge: projectKnowledgeConfigSchema.default({ enabled: false, initialized: false }),
  scan: projectScanConfigSchema.default({ roots: [], includeTests: false, extraExcludes: [] }),
  updatedAt: z.number().int().nonnegative().default(0)
}).strict();
export type ProjectDefinition = z.infer<typeof projectDefinitionSchema>;

export const projectArchitectureSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().nonnegative().default(0),
  decisions: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), detail: z.string().default("") }).strict()).default([]),
  updatedAt: z.number().int().nonnegative().default(0)
}).strict();
export type ProjectArchitectureDocument = z.infer<typeof projectArchitectureSchema>;

export function defaultProjectDefinition(now = Date.now()): ProjectDefinition {
  return { schemaVersion: 1, version: 0, preset: { default: "engineering" }, knowledge: { enabled: false, initialized: false }, scan: { roots: [], includeTests: false, extraExcludes: [] }, updatedAt: now };
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
    return { status: "applied", value };
  }

  async readPresetDefault(): Promise<ReviewPreset> {
    return (await this.readDefinition()).preset.default;
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
    if (!raw) return { schemaVersion: 1, version: 0, decisions: [], updatedAt: 0 };
    try {
      return projectArchitectureSchema.parse(JSON.parse(raw));
    } catch {
      return { schemaVersion: 1, version: 0, decisions: [], updatedAt: 0 };
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
