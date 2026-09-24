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
    themeCss = `:root{--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-editor-background:${background};--vscode-foreground:${foreground};--vscode-descriptionForeground:${foreground};--vscode-input-background:${input};--vscode-input-foreground:${foreground};--vscode-input-placeholderForeground:${foreground};--vscode-input-border:${foreground};--vscode-focusBorder:${accent};--vscode-button-secondaryBackground:${input};--vscode-button-secondaryForeground:${foreground};--vscode-panel-border:${input};--vscode-widget-border:${input};--vscode-badge-background:${input};--vscode-badge-foreground:${foreground};--vscode-list-hoverBackground:${input};--vscode-editorWarning-foreground:#cca700}`;
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
      await load(ui.renderProjectPanel('overview', { ...project, overview: { ...project.overview,
        workspaceSettings: { reviewPreset: 'experience', planDirectory: '.project/plans', apiDirs: ['tools/api'], skillDirs: ['tools/skills'], mcpDirs: ['tools/mcp'] },
        workspaceSettingsVersion: 3,
        evidenceSettings: { depth: 'standard', include: ['src/**'], files: 234 }, evidenceSettingsVersion: 3
      } }));
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-facts')).display`), 'grid');
      assert.equal(await evaluate(`document.querySelector('[data-project-initialization-state]').getAttribute('data-project-initialization-state')`), 'uninitialized');
      assert.equal(await evaluate(`!!document.querySelector('[data-project-initialize]')`), true);
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
      // This select shared its rule with the retired scan/renderer controls, so the surviving
      // declarations are asserted here instead of only being eyeballed in a screenshot. min-width is
      // width-dependent (the narrow layout relaxes it), so the stable declarations are used.
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-ai-cli select')).minHeight`), '28px');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-ai-cli select')).borderRadius`), '4px');
      assert.equal(await evaluate(`document.querySelector('[data-project-workspace-settings] details').open`), false);
      await evaluate(`document.querySelector('[data-project-workspace-settings] summary').click()`);
      assert.equal(await evaluate(`document.querySelector('[data-project-workspace-settings] details').open`), true);
      await evaluate(`document.querySelector('[data-project-directory-add]').click(); document.querySelectorAll('input[name="apiDirs"]')[1].value='more/api'; document.querySelectorAll('input[name="apiDirs"]')[1].dispatchEvent(new Event('input',{bubbles:true})); new Promise(resolve=>setTimeout(resolve,650))`);
      assert.deepEqual(await evaluate(`messages.at(-1)`), { type: 'projectWorkspaceSettings', settings: { reviewPreset: 'experience', planDirectory: '.project/plans', apiDirs: ['tools/api', 'more/api'], skillDirs: ['tools/skills'], mcpDirs: ['tools/mcp'] }, version: 3 });
      await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{type:'projectWorkspaceSettingsSaved',version:4}}))`);
      await evaluate(`document.querySelector('.project-evidence-settings details').open=true; document.querySelector('[name="depth"]').value='whole'; document.querySelector('[name="depth"]').dispatchEvent(new Event('change',{bubbles:true}));`);
      assert.equal(await evaluate(`document.querySelector('[name="chars"]').placeholder`), '1200000');
      assert.equal(await evaluate(`document.querySelector('[name="files"]').value`), '234', 'explicit overrides remain visible');
      await evaluate(`document.querySelector('[data-evidence-use-preset]').click(); document.querySelector('[name="include"]').value='src/**\\ndocs/**'; document.querySelector('[name="include"]').dispatchEvent(new Event('input',{bubbles:true})); new Promise(resolve=>setTimeout(resolve,650))`);
      assert.deepEqual(await evaluate(`messages.at(-1)`), { type: 'projectEvidenceSettings', settings: { depth: 'whole', include: ['src/**', 'docs/**'] }, version: 3 });
      assert.equal(await evaluate(`document.querySelector('.project-evidence-settings fieldset').disabled`), true);
      await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:{type:'projectEvidenceSettingsSaved',error:'Save failed'}}))`);
      assert.equal(await evaluate(`document.querySelector('.project-evidence-settings fieldset').disabled`), false);
      assert.equal(await evaluate(`document.querySelector('[name="depth"]').value`), 'whole');
      assert.match(await evaluate(`document.querySelector('[data-evidence-settings-status]').textContent`), /Save failed/);
      await evaluate(`document.querySelector('[data-project-evidence-settings]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); new Promise(resolve=>setTimeout(resolve,650)); window.dispatchEvent(new MessageEvent('message',{data:{type:'projectEvidenceSettingsSaved',version:4}}))`);
      assert.equal(await evaluate(`document.querySelector('[data-project-evidence-settings]').dataset.version`), '4');
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'expanded settings fit the viewport');
      await evaluate(`document.querySelector('.project-evidence-settings').scrollIntoView({block:'start'})`);
      await writeFile(join(artifacts, `project-settings-${themeName}-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
      await evaluate(`messages=[]`);
      await evaluate(`document.querySelector('button[data-project-page="knowledge"]').click()`);
      assert.equal(await evaluate(`messages[0].page`), 'knowledge');
      await load(ui.renderProjectPanel('knowledge', project));
      assert.equal(await evaluate(`document.querySelectorAll('.architecture-tools, .diagram-adapter-controls, .architecture-graph, .project-scan-folders, .diagram-versions, .architecture-relations').length`), 0);
      await writeFile(join(artifacts, `project-${themeName}-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
    }
  }
  // Match the populated Overview from the reported screenshot, including inline code
  // in the legacy warning and the custom model picker (not just the native CLI select).
  const populated = { ...project, overview: { ...project.overview,
    legacyScanRoots: ['src'], selectedAiCli: 'codex', selectedAiModel: 'gpt-6-astra',
    selectedAiReasoning: 'ultra', selectedAiSpeed: 'fast',
    workspaceSettings: { reviewPreset: 'experience', planDirectory: '.project/plans', apiDirs: ['tools/api'], skillDirs: ['tools/skills'], mcpDirs: ['tools/mcp'] },
    workspaceSettingsVersion: 3,
    initialization: { status: 'completed', drafts: 0, intentGenerated: true, diagramsGenerated: 1 },
    aiCli: [{ id: 'codex', label: 'Codex CLI', models: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', reasoningEfforts: ['high', 'ultra'], speedTiers: ['standard', 'fast'] }] }]
  } };
  for (const width of [320, 701, 792, 1000, 1132]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false });
    await load(ui.renderProjectPanel('overview', populated));
    await writeFile(join(artifacts, `project-populated-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `populated Overview fits ${width}px`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-project-legacy-scan] code')).every(code => code.getClientRects().length === 1)`), true, 'warning code stays inline');
    // Help text, status lines and the AI control rows used to end at 780, 680 and 734 px
    // inside the same 1040 px panel, so the Overview showed three right edges and read as
    // clipped text at a narrow capture. They now share one measure.
    const edges = await evaluate(`['.project-help','[data-project-legacy-scan]','.project-ai-cli','.project-ai-model','.project-initialization-result'].map(selector => { const node = document.querySelector(selector); return node ? Math.round(node.getBoundingClientRect().right) : -1; })`);
    assert.equal(new Set(edges).size, 1, `Overview text shares one right edge at ${width}px: ${JSON.stringify(edges)}`);
    assert.ok(edges[0] >= 0 && edges[0] <= width - 24, `Overview text stays inside the page at ${width}px: ${edges[0]}`);
    // The legacy-scan notice is advisory: its text keeps the normal foreground and only
    // the left rule carries the warning colour. Painting the whole paragraph in Dark+'s
    // #CCA700 was reported as "why is every word yellow" and turned the code chips gold too.
    const notice = await evaluate(`(() => { const style = getComputedStyle(document.querySelector('[data-project-legacy-scan]')); return { color: style.color, body: getComputedStyle(document.body).color, border: style.borderLeftColor, width: style.borderLeftWidth }; })()`);
    assert.equal(notice.color, notice.body, `notice text keeps the normal foreground: ${JSON.stringify(notice)}`);
    assert.equal(notice.border, 'rgb(204, 167, 0)', `notice keeps the warning accent: ${JSON.stringify(notice)}`);
    assert.equal(notice.width, '3px', `notice shows the warning rule: ${JSON.stringify(notice)}`);
    await evaluate(`document.querySelector('[data-project-model-trigger]').click(); document.querySelector('[data-project-model-category="model"]').click()`);
    const bounds = await evaluate(`Array.from(document.querySelectorAll('[data-project-model-menu], [data-project-model-submenu]')).map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })`);
    assert.ok(bounds.every(r => r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= 600), `model menus fit ${width}px: ${JSON.stringify(bounds)}`);
  }
  console.log('PASS: editor styles and navigation under CSP; populated Project Overview and model menus at 320/701/792/1000/1132px. Screenshots: .tmp-tb/editor-tabs-ui');
} finally {
  server?.close();
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
