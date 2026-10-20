// Compatibility entry for callers outside the first migration. Implementation lives in the feature.
export { VIEWER_COMMANDS, archifyViewerBridgeScript, isTrustedHostMessage, isTrustedViewerMessage, isViewerCommand } from "../features/project/browser/archifyBridge.js";
export type { ViewerCommand } from "../features/project/browser/archifyBridge.js";
