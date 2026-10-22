import type { Range } from "./types.js";

export interface DextFileReference {
  expression: string;
  payload: string;
}

export interface ParsedFileReference {
  path: string;
  range?: Range;
}

export interface FileReferenceOccurrence {
  start: number;
  end: number;
  expression: string;
  payload: string;
}

export interface ContextReferenceOccurrence extends FileReferenceOccurrence {
  kind: "file" | "dir" | "symbol" | "selection" | "activeFile" | "project";
  label?: string;
}

/** A reference token is a readable file path. Workspace files use a relative
 * path; explicitly attached external files use a file URI. */
export interface InputReferenceProjection {
  reference: ContextReferenceOccurrence;
  interpolationStart: number;
  interpolationEnd: number;
}

export type InputReferenceDisplayPart =
  | { kind: "text"; value: string }
  | { kind: "ref"; reference: ContextReferenceOccurrence };
