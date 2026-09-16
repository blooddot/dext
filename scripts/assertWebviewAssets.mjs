import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { listFiles } from "@vscode/vsce";

const output = resolve("dist", "webview");
const entries = await readdir(output, { recursive: true });
const files = await Promise.all(
  entries.map(async (entry) => ({ entry: entry.replaceAll("\\", "/"), size: (await stat(resolve(output, entry))).size }))
);
const fileNames = files.filter((file) => file.size > 0).map((file) => file.entry);

for (const required of ["main.js", "main.css", "editor.worker.js"]) {
  assert.ok(fileNames.includes(required), `Missing Webview build asset '${required}'.`);
}
assert.ok(fileNames.includes("editor.worker.js"));
assert.ok((await stat(resolve("dist", "codicons", "codicon.ttf"))).size > 0, "Missing VS Code codicon font.");
const mainBundle = await readFile(resolve(output, "main.js"), "utf8");
const extensionBundle = await readFile(resolve("dist", "extension.js"), "utf8");
const mainStyles = await readFile(resolve(output, "main.css"), "utf8");
// Files on disk can pass build checks while .vscodeignore removes them from the VSIX.
// Keep the History stylesheet's existing URL valid for pages open during an update.
const packagedFiles = new Set((await listFiles()).map((file) => file.replaceAll("\\", "/")));
for (const required of [
  "media/styles.css",
  "media/editorTabs.css",
  "dist/webview/main.css",
  "dist/webview/main.js",
  "dist/webview/editor.worker.js",
  "dist/codicons/codicon.css",
  "dist/codicons/codicon.ttf",
  "dist/markdown/github-markdown.css",
  "dist/markdown/LICENSE"
]) {
  assert.ok(packagedFiles.has(required), `Missing packaged Webview asset '${required}'.`);
}
const historyStyles = await readFile(resolve("media", "styles.css"), "utf8");
const markdownStyles = await readFile(resolve("dist", "markdown", "github-markdown.css"), "utf8");
for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast-light", "vscode-high-contrast"]) {
  assert.ok(markdownStyles.includes(`body.${theme}`), `Markdown is missing the '${theme}' scope.`);
}
assert.ok(!markdownStyles.includes("prefers-color-scheme"), "Markdown must follow VS Code's theme, not the OS theme.");
assert.ok(extensionBundle.includes("github-markdown.css"), "Webviews must load the packaged Markdown theme.");
for (const selector of [".history-view", ".history-session > summary", ".history-session-actions"]) {
  assert.ok(historyStyles.includes(selector), `Missing History style '${selector}'.`);
}
assert.ok(
  !extensionBundle.includes("node_modules/jsonc-parser/lib/umd/main.js"),
  "The extension bundle contains jsonc-parser's UMD entry. Import jsonc-parser/lib/esm/main.js explicitly; the UMD wrapper leaves unresolved relative requires in the VS Code extension host."
);
for (const action of [
  "dext-ref-chip",
  "editor.action.triggerParameterHints",
  "Dext input",
  "insertFileReferences",
  "executeInput",
  "chooseFiles",
  // Per-run Review ships in the conversation bundle.
  "data-turn-review",
  "data-plan-review",
  "data-adopt-suggestion"
]) {
  assert.ok(mainBundle.includes(action), `Missing required Webview behavior '${action}' from the bundle.`);
}
// The migrated editor-tab pages are rendered by the host, so they live in the extension bundle.
for (const action of ["data-resource-open", "data-resource-search", "data-project-page", "data-architecture"]) {
  assert.ok(extensionBundle.includes(action), `Missing migrated editor-tab behavior '${action}' from the extension bundle.`);
}
for (const style of [".turn-review", ".plan-review"]) {
  assert.ok(mainStyles.includes(style), `Missing Review style '${style}'.`);
}

for (const style of ['.monaco-editor', '.squiggly-error', '.squiggly-warning', '.parameter-hints-widget', '.dext-ref-chip']) {
  assert.ok(mainStyles.includes(style), 'Missing Monaco style '+style);
}
for (const font of fileNames.filter(name=>name.endsWith('.ttf'))) assert.ok(packagedFiles.has('dist/webview/'+font), 'Missing Monaco font '+font);
assert.ok(!mainBundle.includes('@codemirror/'), 'Old editor code must not be bundled');
assert.ok(!mainStyles.includes('.cm-editor'), 'Old editor styles must not be bundled');

// --- Project diagrams: Archify runtime completeness and removed-engine absence -----------------
const buildMeta = JSON.parse(await readFile(resolve("dist", "build-meta.json"), "utf8"));
// Guard the manifest shape first: an empty or renamed input list would make every assertion below
// pass without checking anything.
assert.equal(buildMeta.schemaVersion, 1, "dist/build-meta.json was written by an unknown esbuild manifest schema.");
const extensionInputs = buildMeta.entryInputs?.extension;
assert.ok(Array.isArray(extensionInputs) && extensionInputs.length > 0, "The build manifest lists no extension inputs; rerun `npm run build`.");
for (const known of ["src/extension.ts", "src/core/archifyAdapter.ts"]) {
  assert.ok(
    extensionInputs.some((input) => input === known || input.endsWith(`/${known}`)),
    `The build manifest does not list '${known}', so it does not describe this bundle.`
  );
}
for (const forbidden of [
  "typescript/lib/typescript.js",
  "typescript/lib/tsc.js",
  "src/core/projectArchitectureTypeScript.ts",
  "src/core/projectArchitecturePython.ts",
  "src/core/projectArchitectureRust.ts",
  "src/core/projectArchitectureScanner.ts",
  "src/core/projectArchitectureWorker.ts",
  "src/core/drawioAdapter.ts",
  "src/core/mermaidAdapter.ts",
  "src/core/structurizrAdapter.ts"
]) {
  assert.ok(
    !extensionInputs.some((input) => input === forbidden || input.endsWith(`/${forbidden}`)),
    `The runtime bundle must not contain '${forbidden}'; Project parses no source in the extension host.`
  );
}
assert.ok(!extensionBundle.includes("project-diagrams/drawio"), "The removed draw.io runtime must not reach the runtime bundle.");
assert.ok(!extensionBundle.includes("ArchitectureScanResult"), "The removed static scan contract must not reach the runtime bundle.");
for (const required of [
  "vendor/project-diagrams/archify/package.json",
  "vendor/project-diagrams/archify/bin/archify.mjs",
  "vendor/project-diagrams/archify/assets/template.html",
  "vendor/project-diagrams/archify/LICENSE",
  "vendor/project-diagrams/archify/THIRD_PARTY_NOTICES.md",
  "vendor/project-diagrams/archify/schemas/architecture.schema.json",
  "vendor/project-diagrams/archify/schemas/workflow.schema.json",
  "vendor/project-diagrams/archify/schemas/sequence.schema.json",
  "vendor/project-diagrams/archify/schemas/dataflow.schema.json",
  "vendor/project-diagrams/archify/schemas/lifecycle.schema.json",
  "vendor/project-diagrams/archify/renderers/architecture/render-architecture.mjs",
  "vendor/project-diagrams/archify/renderers/workflow/render-workflow.mjs",
  "vendor/project-diagrams/archify/renderers/sequence/render-sequence.mjs",
  "vendor/project-diagrams/archify/renderers/dataflow/render-dataflow.mjs",
  "vendor/project-diagrams/archify/renderers/lifecycle/render-lifecycle.mjs"
]) {
  assert.ok(packagedFiles.has(required), `Missing packaged Archify runtime file '${required}'.`);
}
for (const forbidden of ["vendor/project-diagrams/drawio", "dist/build-meta.json", "dist/extensionHostTest.js"]) {
  assert.ok(
    ![...packagedFiles].some((file) => file === forbidden || file.startsWith(`${forbidden}/`)),
    `'${forbidden}' must not be distributed in the VSIX.`
  );
}
