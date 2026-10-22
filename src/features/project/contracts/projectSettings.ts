import { z } from "zod";
import { DEFAULT_PLAN_DIRECTORY } from "../../conversations/domain/planFile.js";
import { projectEvidenceSettingsSchema, type ProjectEvidenceSettings } from "./projectEvidenceSettings.js";

/** Project-owned settings that affect files and behavior shared by the repository. */
export const projectPathSchema = z.string().trim().min(1).max(512).refine((path) => {
  if (/^[\\/]|^[A-Za-z]:|[\\:]/.test(path)) return false;
  if ([...path].some((character) => character.charCodeAt(0) < 32)) return false;
  return !path.replaceAll("\\", "/").split("/").some((part) => !part || part === "." || part === "..");
}, "Use a workspace-relative path without parent traversal.");

export const projectWorkspaceSettingsSchema = z.object({
  planDirectory: projectPathSchema.default(DEFAULT_PLAN_DIRECTORY),
  apiDirs: z.array(projectPathSchema).max(20).default([]),
  skillDirs: z.array(projectPathSchema).max(20).default([]),
  mcpDirs: z.array(projectPathSchema).max(20).default([])
}).strict();
export type ProjectWorkspaceSettings = z.infer<typeof projectWorkspaceSettingsSchema>;

/** Host-owned tools offered to Agent conversations; the user can turn them off per project. */
export const projectToolSettingsSchema = z.object({
  structureQuery: z.boolean().default(true)
}).strict();
export type ProjectToolSettings = z.infer<typeof projectToolSettingsSchema>;

/** The single Project settings document edited by the Overview panel. */
export const projectSettingsSchema = z.object({
  workspace: projectWorkspaceSettingsSchema,
  evidence: projectEvidenceSettingsSchema,
  tool: projectToolSettingsSchema.default({ structureQuery: true })
}).strict();
export type ProjectSettings = {
  workspace: ProjectWorkspaceSettings;
  evidence: ProjectEvidenceSettings;
  tool: ProjectToolSettings;
};

export const DEFAULT_PROJECT_TOOL_SETTINGS: ProjectToolSettings = { structureQuery: true };

export function projectToolSettingsFromDefinition(
  definition: { tool?: Partial<ProjectToolSettings> | undefined } | undefined
): ProjectToolSettings {
  return projectToolSettingsSchema.parse(definition?.tool ?? {});
}

export const DEFAULT_PROJECT_WORKSPACE_SETTINGS: ProjectWorkspaceSettings = {
  planDirectory: DEFAULT_PLAN_DIRECTORY,
  apiDirs: [],
  skillDirs: [],
  mcpDirs: []
};

export function projectWorkspaceSettingsFromDefinition(
  definition: { paths?: Partial<ProjectWorkspaceSettings> | undefined } | undefined
): ProjectWorkspaceSettings {
  return projectWorkspaceSettingsSchema.parse(definition?.paths ?? {});
}
