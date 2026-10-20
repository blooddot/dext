// Compatibility entry for callers outside the first migration. Implementation lives in the feature.
export { DEFAULT_PROJECT_WORKSPACE_SETTINGS, projectPathSchema, projectSettingsSchema, projectWorkspaceSettingsFromDefinition, projectWorkspaceSettingsSchema } from "../features/project/contracts/projectSettings.js";
export type { ProjectSettings, ProjectWorkspaceSettings } from "../features/project/contracts/projectSettings.js";
