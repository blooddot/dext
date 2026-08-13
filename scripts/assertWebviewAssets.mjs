import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const output = resolve("dist", "webview");
const entries = await readdir(output, { recursive: true });
const files = await Promise.all(
  entries.map(async (entry) => ({ entry: entry.replaceAll("\\", "/"), size: (await stat(resolve(output, entry))).size }))
);
const fileNames = files.filter((file) => file.size > 0).map((file) => file.entry);

for (const required of ["main.js", "main.css"]) {
  assert.ok(fileNames.includes(required), `Missing Webview build asset '${required}'.`);
}
assert.deepEqual(fileNames.filter((file) => file.endsWith(".worker.js")), []);
assert.ok((await stat(resolve("dist", "codicons", "codicon.ttf"))).size > 0, "Missing VS Code codicon font.");
const mainBundle = await readFile(resolve(output, "main.js"), "utf8");
const mainStyles = await readFile(resolve(output, "main.css"), "utf8");
for (const action of [
  "code-file-reference",
  "dext-signature-tooltip",
  "Dext input",
  "insertFileReferences",
  "executeInput",
  "chooseFiles",
  "CodeFiles"
]) {
  assert.ok(mainBundle.includes(action), `Missing required Webview behavior '${action}' from the bundle.`);
}
for (const diagnosticStyle of [
  "dext-diagnostic-error",
  "dext-diagnostic-warning",
  "dext-diagnostic-info",
  "cm-tooltip-lint",
  "--vscode-editorError-foreground"
]) {
  assert.ok(
    mainStyles.includes(diagnosticStyle),
    `Missing required diagnostic style '${diagnosticStyle}' from the Webview CSS.`
  );
}
