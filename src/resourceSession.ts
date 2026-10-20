// Compatibility entry for callers outside the first migration. Implementation lives in the feature.
export { RESOURCE_DIRECTORIES, RESOURCE_ICONS, RESOURCE_LABELS, mergeResourceFiles, resourceFileName, resourceFiles, resourcePathSegments, resourcePrompt } from "./features/resources/contracts/resourceSession.js";
export type { ResourceDocument, ResourceFile, ResourceKind, ResourceScope, ResourceSession, ResourceTarget } from "./features/resources/contracts/resourceSession.js";
