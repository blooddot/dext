import { z } from "zod";
import { DEFAULT_PLAN_DIRECTORY } from "./planFile.js";
import { reviewPresetSchema, type ReviewPreset } from "./projectContext.js";

/** Project-owned settings that affect files and behavior shared by the repository. */
export const projectPathSchema = z.string().trim().min(1).max(512).refine((path) => {
  if (/^[\\/]|^[A-Za-z]:|[\\:]/.test(path)) return false;
  if ([...path].some((character) => character.charCodeAt(0) < 32)) return false;
  return !path.replaceAll("\\", "/").split("/").some((part) => !part || part === "." || part === "..");
}, "Use a workspace-relative path without parent traversal.");

export const projectWorkspaceSettingsSchema = z.object({
  reviewPreset: reviewPresetSchema,
  planDirectory: projectPathSchema.default(DEFAULT_PLAN_DIRECTORY),
  apiDirs: z.array(projectPathSchema).max(20).default([]),
  skillDirs: z.array(projectPathSchema).max(20).default([]),
  mcpDirs: z.array(projectPathSchema).max(20).default([])
}).strict();
export type ProjectWorkspaceSettings = z.infer<typeof projectWorkspaceSettingsSchema>;

export const DEFAULT_PROJECT_WORKSPACE_SETTINGS: ProjectWorkspaceSettings = {
  reviewPreset: "engineering",
  planDirectory: DEFAULT_PLAN_DIRECTORY,
  apiDirs: [],
  skillDirs: [],
  mcpDirs: []
};

export function validProjectPaths(paths: readonly unknown[]): string[] {
  return paths.flatMap((path) => {
    const parsed = projectPathSchema.safeParse(path);
    return parsed.success ? [parsed.data] : [];
  });
}

export function projectWorkspaceSettingsFromDefinition(
  definition: { preset?: { default?: ReviewPreset }; paths?: Partial<Omit<ProjectWorkspaceSettings, "reviewPreset">> | undefined } | undefined,
  legacy: Partial<ProjectWorkspaceSettings> = {}
): ProjectWorkspaceSettings {
  const source = definition?.paths;
  return projectWorkspaceSettingsSchema.parse({
    reviewPreset: definition?.preset?.default ?? legacy.reviewPreset ?? DEFAULT_PROJECT_WORKSPACE_SETTINGS.reviewPreset,
    planDirectory: source?.planDirectory ?? legacy.planDirectory ?? DEFAULT_PLAN_DIRECTORY,
    apiDirs: source?.apiDirs ?? validProjectPaths(legacy.apiDirs ?? []),
    skillDirs: source?.skillDirs ?? validProjectPaths(legacy.skillDirs ?? []),
    mcpDirs: source?.mcpDirs ?? validProjectPaths(legacy.mcpDirs ?? [])
  });
}
