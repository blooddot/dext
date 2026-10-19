import { isProjectEvidencePath, isExcludedProjectEvidencePath } from "./core/projectAiGeneration.js";

export { archifyViewerBridgeScript, VIEWER_COMMANDS, isTrustedViewerMessage, isTrustedHostMessage, isViewerCommand, type ViewerCommand } from "./webview/archifyBridge.js";

/** Exported bytes must belong to the version currently shown; HTML must be a standalone document. */
export function isDiagramExportPayload(format: unknown, content: unknown, expectedVersion: unknown, displayedVersion: unknown): boolean {
  if (expectedVersion !== undefined && displayedVersion !== undefined && expectedVersion !== displayedVersion) return false;
  if (format === "html") return typeof content === "string" && /<html[\s>]/i.test(content);
  if (format === "svg") return typeof content === "string" && content.trimStart().startsWith("<svg") && !/<script[\s>]/i.test(content);
  return false;
}

export function isAllowedEvidencePath(path: string): boolean {
  return isProjectEvidencePath(path) && !isExcludedProjectEvidencePath(path);
}

/**
 * Cancels stale diagram work by stable key. Switching a diagram or closing the page cancels its
 * in-flight render/generation, so a late response can never be promoted.
 */
export class DiagramTaskRegistry {
  private readonly tasks = new Map<string, AbortController>();

  begin(key: string): AbortSignal {
    this.tasks.get(key)?.abort();
    const controller = new AbortController();
    this.tasks.set(key, controller);
    return controller.signal;
  }

  /** Completes a task only when it is still the active one for the key. */
  finish(key: string, signal: AbortSignal): boolean {
    const controller = this.tasks.get(key);
    if (!controller || controller.signal !== signal) return false;
    this.tasks.delete(key);
    return true;
  }

  cancel(key: string): void {
    this.tasks.get(key)?.abort();
    this.tasks.delete(key);
  }

  cancelAll(): void {
    for (const controller of this.tasks.values()) controller.abort();
    this.tasks.clear();
  }

  get activeKeys(): string[] {
    return [...this.tasks.keys()].sort();
  }
}
