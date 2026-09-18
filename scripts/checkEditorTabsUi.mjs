import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const candidates = [process.env.DEXT_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error("Set DEXT_BROWSER to a Chromium/Edge executable.");
const profile = await mkdtemp(join(tmpdir(), "dext-interaction-"));
const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
let server;
let socket;
let shutdown;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  if (!port) throw new Error("Browser debugging port did not start.");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  shutdown = () => send("Browser.close");
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const key = async (key, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: code, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) }); await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code }); };

  const bundle = await build({ stdin: { contents: 'export { renderEditorTabHtml } from "./src/editorTabHtml.ts"; export { buildResourceList, renderResourceDefinition, buildResourceDefinition } from "./src/resourceDocuments.ts"; export { renderApiList } from "./src/webview/apiPanel.ts"; export { renderGlobalResources } from "./src/webview/globalResourcesPanel.ts"; export { renderProjectPanel } from "./src/webview/projectPanel.ts";', resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "esm" });
  const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const css = await readFile('media/editorTabs.css', 'utf8');
  let pageHtml = '', themeCss = '', themeClass = '';
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/style.css' ? 'text/css' : 'text/html');
    response.end(request.url === '/style.css' ? themeCss + css : pageHtml);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const entries = [
    { kind: 'api', scope: 'global', name: 'agent', path: 'agent.dx', group: '.', description: 'Run an agent task', source: { kind: 'directory', label: 'builtin' } },
    { kind: 'api', scope: 'global', name: 'node.fs.readFile', path: 'node/fs/readFile.dx', group: 'node.fs', description: 'Read file contents', source: { kind: 'directory', label: 'builtin' } }
  ];
  entries[0].api = {
    signature: 'agent(input: string, apply?: boolean = True, cli?: "codex" | "claude") -> AgentResult',
    parameters: [
      { name: 'input', type: 'string', required: true },
      { name: 'apply', type: 'boolean', required: false, defaultValue: 'true' },
      { name: 'cli', type: '"codex" | "claude"', required: false }
    ], returnType: 'AgentResult'
  };
  entries[1].api = { signature: 'node.fs.readFile(path: string) -> NodeFsReadFileResult', parameters: [{ name: 'path', type: 'string', required: true }], returnType: 'NodeFsReadFileResult' };
  const project = { overview: { name: 'Dext', root: 'C:/github/blooddot/dext', objects: 0, accepted: 0, drafts: 0, needsVerification: 0, initialization: { status: 'uninitialized', drafts: 0 }, aiCli: [{ id: 'codex', label: 'Codex', models: [] }] }, objects: [], architecture: { diagrams: [] } };
  const artifacts = resolve('.tmp-tb/editor-tabs-ui'); await mkdir(artifacts, { recursive: true });
  async function load(body) {
    pageHtml = ui.renderEditorTabHtml('<script>window.messages=[];window.acquireVsCodeApi=()=>({postMessage:message=>messages.push(message)});</script>' + body, `${origin}/style.css`, origin);
    await send('Page.navigate', { url: `${origin}/?${Date.now()}` });
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('.editor-tab') && !!window.messages`)) {
        await evaluate(`document.body.classList.add(${JSON.stringify(themeClass)})`);
        return;
      }
      await new Promise(done => setTimeout(done, 30));
    }
    throw new Error('Page did not load');
  }
  for (const [themeName, background, foreground, input, accent] of [['dark', '#1e1e1e', '#ccc', '#313131', '#007acc'], ['light', '#fff', '#333', '#eee', '#005fb8'], ['contrast', '#000', '#fff', '#000', '#ffff00']]) {
    themeClass = themeName === 'contrast' ? 'vscode-high-contrast' : `vscode-${themeName}`;
    themeCss = `:root{--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-editor-background:${background};--vscode-foreground:${foreground};--vscode-descriptionForeground:${foreground};--vscode-input-background:${input};--vscode-input-foreground:${foreground};--vscode-input-placeholderForeground:${foreground};--vscode-input-border:${foreground};--vscode-focusBorder:${accent};--vscode-button-secondaryBackground:${input};--vscode-button-secondaryForeground:${foreground};--vscode-panel-border:${input};--vscode-widget-border:${input};--vscode-badge-background:${input};--vscode-badge-foreground:${foreground};--vscode-list-hoverBackground:${input}}`;
    // Simulate VS Code's default inline-code background so the regression is visible here.
    themeCss += 'code{background:#383838;padding:2px 4px;border-radius:3px;}';
    for (const width of [320, 1000]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await load(ui.renderApiList(ui.buildResourceList({ kind: 'api', scope: 'project', entries })));
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.resource-toolbar')).display`), 'flex');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.resource-group ul')).listStyleType`), 'none');
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
      assert.equal(await evaluate(`document.querySelectorAll('[data-resource-toggle-all]').length`), 1);
      await evaluate(`document.querySelector('[data-resource-toggle-all] svg path').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-resource-node]')).every(node=>!node.open)`), true);
      assert.equal(await evaluate(`document.querySelector('[data-resource-toggle-all]').getAttribute('aria-label')`), 'Expand all');
      await evaluate(`document.querySelector('[data-resource-toggle-all]').focus()`);
      await key('Enter', 13);
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-resource-node]')).every(node=>node.open)`), true);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.resource-entry-signature')).backgroundColor`), 'rgba(0, 0, 0, 0)');
      assert.equal(await evaluate(`new Set(['.tok-function','.tok-propertyName','.tok-typeName','.tok-string'].map(selector=>getComputedStyle(document.querySelector('.resource-entry-signature '+selector)).color)).size`), 4);
      assert.equal(await evaluate(`document.querySelector('.resource-toolbar [data-resource-command]').textContent.trim()`), '');
      await evaluate(`window.search=document.querySelector('input');search.focus();search.value='read';search.dispatchEvent(new Event('input',{bubbles:true}));`);
      assert.equal(await evaluate(`document.activeElement === search`), true, 'search retains focus');
      assert.equal(await evaluate(`document.querySelectorAll('.resource-entry:not([hidden])').length`), 1);
      await evaluate(`search.value='missing';search.dispatchEvent(new Event('input',{bubbles:true}));`);
      assert.equal(await evaluate(`document.querySelector('[data-resource-no-results]').hidden`), false);
      await evaluate(`search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-resource-open]').click();`);
      assert.equal(await evaluate(`messages.length`), 1);
      assert.equal(await evaluate(`messages[0].type`), 'resourceOpen');
      await writeFile(join(artifacts, `apis-${themeName}-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
      await load(ui.renderResourceDefinition(ui.buildResourceDefinition(entries[0], 'def main(input: str):\n    return agent(input=input)')));
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.resource-api-signature code')).backgroundColor`), 'rgba(0, 0, 0, 0)');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('dt .tok-propertyName')).color !== getComputedStyle(document.querySelector('dt .tok-typeName')).color`), true);
      await writeFile(join(artifacts, `api-detail-${themeName}-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
      // The Resources page must file MCP tools under MCP and nest every category the way the API
      // page does: `dev` holds `feat`, and the tool server holds its own tools.
      const resourceEntries = [
        { kind: 'api', scope: 'project', name: 'dev.feat', path: 'dev/feat.dx', group: 'dev', description: 'Plan a feature', source: { kind: 'project', label: 'project' } },
        { kind: 'api', scope: 'project', name: 'dev.fix', path: 'dev/fix.dx', group: 'dev', description: 'Fix a defect', source: { kind: 'project', label: 'project' } },
        { kind: 'api', scope: 'project', name: 'mcp.files.readFile', path: 'mcp/files/readFile.dx', group: 'mcp.files', description: 'Read a file', source: { kind: 'project', label: 'project' } }
      ];
      await load(ui.renderGlobalResources(ui.buildResourceList({ kind: 'api', scope: 'project', entries: resourceEntries, groupBy: 'kind' }), { title: 'Resources', createKinds: ['api','mcp','rule','skill'] }));
      assert.equal(await evaluate(`document.querySelectorAll('.resource-group:not(.resource-api-node)').length`), 4);
      assert.equal(await evaluate(`document.querySelectorAll('[data-resource-group-action]').length`), 4);
      assert.equal(await evaluate(`document.querySelectorAll('[data-resource-toggle-all]').length`), 0);
      assert.equal(await evaluate(`document.querySelector('[data-resource-node="API.dev"] .resource-name').textContent`), 'feat');
      assert.equal(await evaluate(`document.querySelector('[data-resource-node="API"]').querySelectorAll('.resource-entry').length`), 2);
      assert.equal(await evaluate(`document.querySelector('[data-resource-node="MCP.files"] .resource-name').textContent`), 'readFile');
      assert.equal(await evaluate(`!!document.querySelector('[data-resource-node="API"]').querySelector('[data-resource-id="api:project:mcp/files/readFile.dx"]')`), false);
      assert.equal(await evaluate(`!!document.querySelector('[data-resource-node="MCP"]').querySelector('[data-resource-id="api:project:mcp/files/readFile.dx"]')`), true);
      await evaluate(`document.querySelector('[data-resource-group-target="API"] svg path').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
      assert.equal(await evaluate(`document.querySelector('[data-resource-node="API"]').open`), false);
      assert.equal(await evaluate(`document.querySelector('[data-resource-node="MCP"]').open`), true);
      assert.equal(await evaluate(`document.querySelector('[data-resource-group-target="API"]').title`), 'Expand API');
      await evaluate(`document.querySelector('[data-resource-group-target="API"]').click()`);
      assert.equal(await evaluate(`document.querySelector('[data-resource-node="API"]').open`), true);
      await evaluate(`document.querySelector('.resource-toolbar [data-resource-command] svg path').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`);
      assert.equal(await evaluate(`messages[0].command`), 'dext.reloadMethods');
      await evaluate(`messages=[]`);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
      await evaluate(`document.querySelector('button[data-resource-kind="skill"]').click()`);
      assert.equal(await evaluate(`messages[0].kind`), 'skill');
      await writeFile(join(artifacts, `resources-${themeName}-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
      await load(ui.renderProjectPanel('overview', project));
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-facts')).display`), 'grid');
      assert.equal(await evaluate(`document.querySelector('[data-project-initialization-state]').getAttribute('data-project-initialization-state')`), 'uninitialized');
      assert.equal(await evaluate(`!!document.querySelector('[data-project-initialize]')`), true);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
      // This select shared its rule with the retired scan/renderer controls, so the surviving
      // declarations are asserted here instead of only being eyeballed in a screenshot. min-width is
      // width-dependent (the narrow layout relaxes it), so the stable declarations are used.
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-ai-cli select')).minHeight`), '28px');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-ai-cli select')).borderRadius`), '4px');
      await evaluate(`document.querySelector('button[data-project-page="knowledge"]').click()`);
      assert.equal(await evaluate(`messages[0].page`), 'knowledge');
      await load(ui.renderProjectPanel('knowledge', project));
      assert.equal(await evaluate(`document.querySelectorAll('.architecture-tools, .diagram-adapter-controls, .architecture-graph, .project-scan-folders, .diagram-versions, .architecture-relations').length`), 0);
      await writeFile(join(artifacts, `project-${themeName}-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
    }
  }
  console.log('PASS: editor styles load under CSP; APIs, Global Resources and Project in dark/light/contrast at 320/1000px; search focus and filtering; category creation and page navigation. Screenshots: .tmp-tb/editor-tabs-ui');
} finally {
  server?.close();
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
