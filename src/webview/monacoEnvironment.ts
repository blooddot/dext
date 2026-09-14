import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";

export { monaco };
/** VS Code webviews load workers from a blob containing the bundled worker.
 * No eval, CDN, dynamic import or workspace URL is required. */
export function initializeMonacoWorkers(uri: string): { dispose(): void } {
  const workers = new Set<Worker>();
  const abort = new AbortController();
  let disposed = false;
  let blobUrl: string | undefined;
  const workerUrl = fetch(uri, { signal: abort.signal }).then(async response => {
    if (!response.ok) throw new Error(`Editor worker: HTTP ${response.status}`);
    const code = await response.text();
    if (disposed) throw new Error("Editor disposed");
    blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    return blobUrl;
  });
  // Keep a rejected fetch handled until Monaco requests its worker.
  void workerUrl.catch(() => undefined);
  Object.assign(globalThis, { MonacoEnvironment: { getWorker: async () => {
    const url = await workerUrl;
    if (disposed) throw new Error("Editor disposed");
    const worker = new Worker(url); workers.add(worker); return worker;
  } } });
  return { dispose() { disposed = true; abort.abort(); for (const worker of workers) worker.terminate();
    if (blobUrl) URL.revokeObjectURL(blobUrl); } };
}
