import type { ReaderApi } from "./projectReader.js";
import { foldProjectDirectory, startProjectReader } from "./projectReader.js";
import { isTrustedHostMessage } from "./archifyBridge.js";

const root = document.querySelector<HTMLElement>("[data-project-reader]");
const api = (window as Window & { __dextApi?: ReaderApi }).__dextApi;
if (root && api) startProjectReader(root, api);
if (root) foldProjectDirectory(root);

if (api) {
  let nextRequestId = 0;
  const pending = new Map<number, { button: HTMLButtonElement; timer: number }>();
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-project-quality-copy]") : null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    const requestId = ++nextRequestId;
    button.disabled = true;
    button.textContent = "Copying…";
    const timer = window.setTimeout(() => finish(requestId, false), 10000);
    pending.set(requestId, { button, timer });
    api.postMessage({ type: "projectQualityCopy", requestId, text: button.dataset.projectQualityCopy ?? "" });
  });
  const finish = (requestId: number, success: boolean) => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    window.clearTimeout(request.timer);
    request.button.disabled = false;
    request.button.textContent = success ? "Copied" : "Copy failed";
  };
  window.addEventListener("message", (event: MessageEvent<{ type?: unknown; requestId?: unknown; success?: unknown }>) => {
    if (!isTrustedHostMessage(event.source, root?.querySelector("iframe")?.contentWindow, event.data)) return;
    const message = event.data;
    if (message?.type === "projectQualityCopied" && typeof message.requestId === "number") finish(message.requestId, message.success === true);
  });
}
