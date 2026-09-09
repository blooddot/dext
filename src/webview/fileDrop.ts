const uriListTypes = ["application/vnd.code.uri-list", "text/uri-list"];

/** Capture on the whole composer before CodeMirror filters widget events or
 * consumes drops. Its domEventHandlers only listen on the editable content. */
export function bindFileDropTarget(target: HTMLElement, handlers: {
  dragover(event: DragEvent): boolean;
  drop(event: DragEvent): boolean;
  leave: () => void;
}): () => void {
  const over = (event: DragEvent) => {
    if (handlers.dragover(event)) event.stopPropagation();
  };
  const drop = (event: DragEvent) => {
    if (handlers.drop(event)) event.stopPropagation();
  };
  const leave = (event: DragEvent) => {
    if (!event.relatedTarget || !target.contains(event.relatedTarget as Node)) handlers.leave();
  };
  const window = target.ownerDocument.defaultView;
  target.addEventListener("dragenter", over, true);
  target.addEventListener("dragover", over, true);
  target.addEventListener("drop", drop, true);
  target.addEventListener("dragleave", leave, true);
  window?.addEventListener("dragend", handlers.leave);
  window?.addEventListener("blur", handlers.leave);
  return () => {
    target.removeEventListener("dragenter", over, { capture: true });
    target.removeEventListener("dragover", over, { capture: true });
    target.removeEventListener("drop", drop, { capture: true });
    target.removeEventListener("dragleave", leave, { capture: true });
    window?.removeEventListener("dragend", handlers.leave);
    window?.removeEventListener("blur", handlers.leave);
    handlers.leave();
  };
}

function read(data: DataTransfer, type: string): string {
  const actual = [...data.types].find((candidate) => candidate.toLowerCase() === type);
  return actual ? data.getData(actual) : "";
}

function paths(text: string, uriList = false): string[] {
  const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim())
    .filter((line) => line && !(uriList && line.startsWith("#")))
    .map((line) => line.replace(/^"(.*)"$/, "$1"));
  return lines.length && lines.every((line) => /^(?:(?:file|vscode-remote):\/\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/i.test(line))
    ? [...new Set(lines)] : [];
}

/** During dragover the browser exposes types, but keeps payloads protected. */
export function isFileDrag(event: Pick<DragEvent, "shiftKey" | "dataTransfer">): boolean {
  return event.shiftKey && !!event.dataTransfer && [...event.dataTransfer.types].some((type) =>
    [...uriListTypes, "resourceurls", "text/plain", "files"].includes(type.toLowerCase()));
}

/** VS Code's standard URI list can contain only the first selected file.
 * Prefer its full internal list, then resource URLs, before standard formats. */
export function droppedFilePaths(data: DataTransfer | null): string[] {
  if (!data) return [];
  const internal = paths(read(data, uriListTypes[0]!), true);
  if (internal.length) return internal;
  try {
    const resources: unknown = JSON.parse(read(data, "resourceurls") || "null");
    if (Array.isArray(resources) && resources.every((item) => typeof item === "string" && !/[\r\n]/.test(item))) {
      const result = paths(resources.join("\n"));
      if (result.length) return result;
    }
  } catch { /* Fall back to the standard transfer formats. */ }
  const standard = paths(read(data, uriListTypes[1]!), true);
  return standard.length ? standard : paths(read(data, "text/plain"));
}
