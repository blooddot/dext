import type { DirRef, Range } from "./types.js";

/** A text snapshot a host resolves from the editor or a file read. */
export interface TextSnapshot {
  uri: string;
  content: string;
  version: number;
  range?: Range;
  symbol?: string;
}

/** The narrow host surface the context resolver needs. */
export interface ContextHost {
  selection(): Promise<TextSnapshot | undefined>;
  activeFile(): Promise<TextSnapshot | undefined>;
  file(path: string): Promise<TextSnapshot | undefined>;
  symbol(name: string): Promise<TextSnapshot | undefined>;
  dir(path: string): Promise<DirRef | undefined>;
}
