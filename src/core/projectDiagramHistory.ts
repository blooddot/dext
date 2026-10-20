// Compatibility entry for callers outside the first migration. Implementation lives in the feature.
export { ProjectDiagramHistory, compareDiagramSnapshots, createDiagramSnapshot, isArchifySnapshot, isUsableDiagramSnapshot } from "../features/project/knowledge/projectDiagramHistory.js";
export type { DiagramEntityDelta, DiagramEvidenceDelta, DiagramLayoutDelta, ProjectDiagramComparison, ProjectDiagramDelta, ProjectDiagramHistoryEntry, ProjectDiagramHistoryState, ProjectDiagramRenderedLayout, ProjectDiagramSnapshot } from "../features/project/knowledge/projectDiagramHistory.js";
