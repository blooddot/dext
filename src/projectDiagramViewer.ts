// Compatibility entry for callers outside the first migration. Implementation lives in the feature.
export { archifyViewerBridgeScript, isTrustedHostMessage, isTrustedViewerMessage, isViewerCommand } from "./features/project/browser/archifyBridge.js";
export { DiagramTaskRegistry, isAllowedEvidencePath, isDiagramExportPayload } from "./features/project/host/diagrams/projectDiagramViewer.js";
