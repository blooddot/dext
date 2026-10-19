import type { ProjectDiagram } from "../core/projectDiagram.js";
import { archifyViewerBridgeScript, isTrustedHostMessage, isTrustedViewerMessage } from "./archifyBridge.js";

export interface ReaderArchifyView {
  ready: Promise<void>;
  command(command: string, extra?: Record<string, unknown>): void;
  dispose(): void;
}

/** One sandbox/session per displayed snapshot. Closing it detaches every late message. */
export function renderReaderArchify(diagram: ProjectDiagram, canvas: HTMLElement, postMessage: (message: unknown) => void,
  inspect: (id: string, kind: "node" | "relation") => void, exitPresentation?: () => void): ReaderArchifyView {
  const requestId = crypto.randomUUID();
  const session = crypto.randomUUID();
  const frame = document.createElement("iframe");
  frame.className = "project-reader-archify";
  frame.title = diagram.title;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("allow", "fullscreen");
  canvas.append(frame);
  let mapping: { ids?: Record<string, string>; reverseIds?: Record<string, string>; reverseRelationIds?: Record<string, string> } = {};
  let settled = false;
  let disposed = false;
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const ready = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  const timer = window.setTimeout(() => fail("The interactive renderer did not respond."), 30_000);
  const command = (command: string, extra: Record<string, unknown> = {}) => {
    if (!disposed) frame.contentWindow?.postMessage({ __dext: session, type: "dext-diagram-command", command, requestId, ...extra }, "*");
  };
  const fail = (reason: string) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(reason)); } };
  const listener = (event: MessageEvent) => {
    if (disposed || !canvas.isConnected) return;
    const raw: unknown = event.data;
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    if (isTrustedViewerMessage(event.source, frame.contentWindow, message, session)) {
      if (message.type === "dext-diagram-ready") {
        if (message.archify !== true) { fail("The interactive renderer could not start."); return; }
        command("map", { nodes: mapping.reverseIds ?? {}, ids: mapping.ids ?? {}, relations: mapping.reverseRelationIds ?? {} });
        if (!settled) { settled = true; clearTimeout(timer); resolve(); }
      }
      if (message.type === "dext-diagram-node" && typeof message.nodeId === "string") inspect(message.nodeId, "node");
      if (message.type === "dext-diagram-relation" && typeof message.relationId === "string") inspect(message.relationId, "relation");
      if (message.type === "dext-diagram-escape") exitPresentation?.();
      if (message.type === "dext-diagram-export" && typeof message.content === "string") postMessage({ type: "projectReaderExport", diagramId: diagram.id, updatedAt: diagram.updatedAt, content: message.content });
      return;
    }
    if (!isTrustedHostMessage(event.source, frame.contentWindow, message) || message.type !== "projectReaderRendered" || message.requestId !== requestId
      || message.diagramId !== diagram.id || message.updatedAt !== diagram.updatedAt) return;
    if (message.error || typeof message.html !== "string") { fail(typeof message.error === "string" ? message.error : "Invalid render response."); return; }
    mapping = message.mapping && typeof message.mapping === "object" ? message.mapping as typeof mapping : {};
    const theme = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light") ? "light" : "dark";
    const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "";
    const bridge = `<script nonce="${nonce}">${archifyViewerBridgeScript(session, theme, Boolean(exitPresentation))}</script>`;
    frame.srcdoc = message.html.replace(/<head>/i, `<head>${bridge}`).replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
  };
  window.addEventListener("message", listener);
  postMessage({ type: "projectReaderRender", diagramId: diagram.id, updatedAt: diagram.updatedAt, requestId });
  return { ready, command, dispose: () => { disposed = true; clearTimeout(timer); window.removeEventListener("message", listener); frame.remove(); fail("View closed."); } };
}
