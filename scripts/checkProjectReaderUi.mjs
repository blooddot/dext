import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm, access, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const candidates = [process.env.DEXT_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error("Set DEXT_BROWSER to a Chromium/Edge executable.");
const profile = await mkdtemp(join(tmpdir(), "dext-project-reader-"));
const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--disable-extensions", "--disable-sync", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
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
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  shutdown = () => send("Browser.close");
  const evaluate = async (expression, userGesture = false) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const evaluateViewer = async (expression) => {
    const { frameTree } = await send("Page.getFrameTree");
    let result;
    if (frameTree.childFrames?.length) {
      const { executionContextId } = await send("Page.createIsolatedWorld", { frameId: frameTree.childFrames[0].frame.id, worldName: "diagram-layout-check" });
      result = await send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true });
    } else {
      // Sandboxed srcdoc can run in a separate renderer process.
      const { targetInfos } = await send("Target.getTargets");
      const target = targetInfos.find((entry) => entry.type === "iframe");
      assert.ok(target, "sandboxed viewer target exists");
      const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      try { result = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId); }
      finally { await send("Target.detachFromTarget", { sessionId }); }
    }
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const key = async (key, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: code, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) }); await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code }); };


  const bundle = await build({ stdin: { contents: 'export { renderEditorTabHtml } from "./src/platform/editor-tabs/editorTabHtml.ts"; export { renderProjectPanel } from "./src/features/project/presentation/projectPanel.ts"; export { buildProjectTopics, topicFingerprint } from "./src/features/project/knowledge/projectTopics.ts"; export { projectIntentSchema } from "./src/features/project/contracts/projectIntent.ts"; export { ArchifyAdapter } from "./src/features/project/host/diagrams/archifyAdapter.ts";', resolveDir: process.cwd() }, bundle: true, write: false, platform: "node", format: "esm" });
  const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const adapter = new ui.ArchifyAdapter(resolve('vendor/project-diagrams/archify'));
  const cache = new Map();
  let currentData, failRender = false;
  await send('Runtime.enable');
  await send('Runtime.addBinding', { name: 'projectHostMessage' });
  socket.addEventListener('message', async ({ data }) => {
    const event = JSON.parse(data);
    if (event.method !== 'Runtime.bindingCalled' || event.params.name !== 'projectHostMessage') return;
    const request = JSON.parse(event.params.payload);
    if (request.type !== 'projectReaderRender') return;
    const response = { ...request, type: 'projectReaderRendered' };
    try {
      if (failRender) throw new Error('Fixture render failure');
      const model = [...currentData.readerDiagrams, ...currentData.knowledge.topics.map(t => t.diagram).filter(Boolean)].find(d => d.id === request.diagramId && d.updatedAt === request.updatedAt);
      assert.ok(model, 'render request identifies an existing snapshot');
      const key = JSON.stringify(model);
      if (!cache.has(key)) cache.set(key, (async () => {
        const document = await adapter.transform(model);
        const artifact = await adapter.render(document);
        const receipt = await adapter.validate(document);
        assert.notEqual(receipt.status, 'failed', JSON.stringify(receipt.issues));
        return { html: artifact.content, mapping: document.payload.mapping };
      })());
      Object.assign(response, await cache.get(key));
    } catch (error) { response.error = error.message; console.error('Host render:',error.message); }
    await hostMessage(response).catch(() => {});
  });
  const css = await readFile('media/editorTabs.css', 'utf8');
  const js = await readFile('dist/webview/project.js', 'utf8');
  let pageHtml = '', themeCss = '';
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/style.css' ? 'text/css' : request.url === '/project.js' ? 'application/javascript' : 'text/html');
    response.end(request.url === '/style.css' ? themeCss + css : request.url === '/project.js' ? js : pageHtml);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evidence = [{ path: 'src/runner.ts', line: 12, contentHash: 'saved' }];
  const intent = ui.projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 10, brief: { name: 'Dext', summary: 'Understand execution from the editor to the kernel.' },
    capabilities: [
      { id: 'area.editing', canonicalName: 'Editing', description: 'Prepare code for execution.', contextIds: ['editor'] },
      { id: 'area.execution', canonicalName: 'Workflow execution', description: 'Execute reusable workflows.', contextIds: ['kernel'] }
    ], contexts: [
    { id: 'editor', canonicalName: 'Code editor', purpose: 'Collect code and submit a run.', dependsOn: ['kernel'], evidence },
    { id: 'kernel', canonicalName: 'Execution kernel', purpose: 'Execute TypeScript and await tracked calls.', evidence }
  ], flows: [{ id: 'run', canonicalName: 'Run TypeScript', description: 'Follow a submitted module until its tracked calls settle.', trigger: 'Submit Code', evidence, steps: [
    { id: 'submit', label: 'Submit code', description: 'The editor sends the current module.', contextId: 'editor', nextStepIds: ['execute'], evidence },
    { id: 'execute', label: 'Execute module', description: 'The kernel loads the module and runs its exports.', contextId: 'kernel', nextStepIds: ['settle'], evidence },
    { id: 'settle', label: 'Await calls', description: 'The run finishes when tracked calls settle.', contextId: 'kernel', evidence }
  ] }] });
  const node = (id, label, extra = {}) => ({ id, label, role: 'component', semanticIds: [id], evidence, ...extra });
  const relation = (id, from, to, extra = {}) => ({ id, from, to, kind: 'calls', label: 'send request', evidence, ...extra });
  const diagram = (kind, semantics = {}) => ({ schemaVersion: 1, id: kind, title: `${kind} saved view`, kind, version: 1, updatedAt: 10, nodes: [node('editor', 'Code editor', { ...(kind === 'data_flow' ? { stageId: 'input' } : {}), ...(kind === 'workflow' ? { laneId: 'ui' } : {}) }), node('kernel', 'Execution kernel', { role: 'store', ...(kind === 'data_flow' ? { stageId: 'output' } : {}), ...(kind === 'workflow' ? { laneId: 'host' } : {}) })], relations: [relation('request', 'editor', 'kernel')], semantics });
  const diagrams = [diagram('architecture', { boundaries: [{ id: 'app', label: 'Application', nodeIds: ['editor', 'kernel'], evidence }] }), diagram('workflow', { lanes: [{ id: 'ui', label: 'Editor', evidence }, { id: 'host', label: 'Host', evidence }] }), diagram('sequence', { participants: [{ nodeId: 'editor', order: 0 }, { nodeId: 'kernel', order: 1 }], messages: [{ relationId: 'request', order: 0, kind: 'call', evidence }] }), diagram('data_flow', { stages: [{ id: 'input', label: 'Input', order: 0, evidence }, { id: 'output', label: 'Output', order: 1, evidence }] }), diagram('lifecycle', { states: [{ nodeId: 'editor', kind: 'initial', evidence }, { nodeId: 'kernel', kind: 'terminal', outcome: 'success', evidence }], transitions: [{ relationId: 'request', event: 'Submit', evidence }] })];
  intent.c4 = { systemId: 'dext-system', elements: [
    { id: 'dext-system', name: 'Dext system', kind: 'system', description: 'Development assistant', contextIds: [], evidence },
    { id: 'developer', name: 'Developer', kind: 'person', description: 'Runs tasks', contextIds: [], evidence },
    { id: 'webview', name: 'Webview', kind: 'container', parentId: 'dext-system', description: 'Browser UI', technology: 'Chromium', contextIds: ['editor'], evidence },
    { id: 'extension', name: 'Extension host', kind: 'container', parentId: 'dext-system', description: 'Hosts execution', technology: 'Node.js', contextIds: ['kernel'], evidence }
  ], relationships: [
    { id: 'uses-dext', from: 'developer', to: 'dext-system', description: 'Uses assistant', evidence },
    { id: 'posts-command', from: 'webview', to: 'extension', description: 'Sends commands', evidence }
  ] };
  const topics = ui.buildProjectTopics(intent, diagrams);
  const data = { overview: { name: 'Dext', root: '.', objects: 0, accepted: 0, drafts: 0, needsVerification: 0, initialization: { status: 'completed' } }, objects: [], architecture: { diagrams }, readerDiagrams: diagrams, knowledge: { brief: intent.brief.summary, topics } };
  const artifacts = resolve('.tmp-tb/project-reader-ui'); await mkdir(artifacts, { recursive: true });
  const wait = async (expression, label) => { for (let i = 0; i < 600; i++) { if (await evaluate(expression)) return; await new Promise(done => setTimeout(done, 50)); } throw new Error(`${label}: ${JSON.stringify(await evaluate(`({status:document.querySelector('[data-reader-render-status]')?.textContent,messages:window.messages,violations:window.violations,frame:document.querySelector('iframe')?.srcdoc.length})`))}`); };
  const ready = () => wait(`document.querySelector('[data-reader-canvas]')?.dataset.state==='ready' || (!document.querySelector('[data-reader-canvas]') && !!document.querySelector('[data-reader-analysis-state]'))`, 'Diagram did not render');
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  const hostMessage = (message) => evaluate(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(message)}}))`);
  const load = async (theme, pageData = data, filters = { topic: 'run' }) => {
    currentData = pageData;
    const light = theme === 'vscode-light';
    themeCss = `:root{--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-editor-background:${light ? '#fff' : '#1e1e1e'};--vscode-foreground:${light ? '#333' : '#ddd'};--vscode-descriptionForeground:${light ? '#555' : '#bbb'};--vscode-input-background:${light ? '#eee' : '#313131'};--vscode-input-foreground:${light ? '#333' : '#ddd'};--vscode-panel-border:${light ? '#ddd' : '#555'};--vscode-focusBorder:#0088ff;--vscode-list-activeSelectionBackground:#004c80;--vscode-list-activeSelectionForeground:#fff;--vscode-button-secondaryBackground:${light ? '#eee' : '#313131'};--vscode-textBlockQuote-background:${light ? '#eee' : '#292929'}}`;
    pageHtml = ui.renderEditorTabHtml(`<script>document.body.classList.add('${theme}');window.messages=[];window.violations=[];document.addEventListener('securitypolicyviolation',e=>violations.push(e.violatedDirective));window.state={filters:${JSON.stringify(filters)}};window.acquireVsCodeApi=()=>({postMessage:m=>{messages.push(m);projectHostMessage(JSON.stringify(m))},getState:()=>state,setState:s=>{state=s}});</script>` + ui.renderProjectPanel('knowledge', pageData, { state: { key: 'dext.editor:project', page: 'knowledge', filters: {}, restoreVersion: 1 } }), `${origin}/style.css`, origin, { embedFrames: true, scriptUri: `${origin}/project.js` });
    await send('Page.navigate', { url: `${origin}/?${Date.now()}` });
    await wait(`document.readyState==='complete' && !!window.messages && !!document.querySelector('[data-reader-article]')`, 'reader load');
    await ready();
  };
  for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast']) {
    for (const width of [320, 1400]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false });
      await load(theme);
      assert.equal(await evaluate(`document.querySelector('[data-reader-article] h2').textContent`), 'Run TypeScript', 'restore selected topic');
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'reader fits viewport');
      assert.equal(await evaluate(`document.querySelectorAll('[data-reader-area]').length`), 2, 'generated functional areas group module navigation');
      assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.renderer`), 'archify');
      assert.equal(await evaluateViewer(`!!document.querySelector('svg [data-node-id]')`), true);
      await evaluateViewer(`Array.from(document.querySelectorAll('[data-node-id]')).find(n => n.textContent.includes('Execute module')).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
      await wait(`document.querySelector('[data-reader-section="execute"]').classList.contains('is-selected')`, 'native node links to prose');
      assert.equal(await evaluate(`document.querySelector('[data-reader-section="execute"]').classList.contains('is-selected')`), true);
      assert.match(await evaluate(`document.querySelector('[data-reader-inspector]').textContent`), /kernel loads the module/);
      await click('[data-reader-inspector] [data-reader-element-source]');
      assert.deepEqual(await evaluate('messages.at(-1)'), { type: 'projectReaderEvidence', diagramId: 'topic-view:run', updatedAt: 10, elementId: 'execute', elementKind: 'node', evidenceIndex: 0 });
      await click('[data-reader-step="settle"]');
      await wait(`document.querySelector('[data-reader-section="settle"]').classList.contains('is-selected')`, 'prose selection');
      assert.match(await evaluateViewer(`Array.from(document.querySelectorAll('[data-node-id]')).find(n=>n.textContent.includes('Await calls')).style.filter`), /drop-shadow/);
      await click('[data-reader-next]');
      assert.equal(await evaluate(`document.querySelector('[data-reader-section="submit"]').classList.contains('is-selected')`), true);
      await click('[data-reader-relation="submit->execute"]');
      await click('[data-reader-inspector] [data-reader-element-source]');
      assert.equal(await evaluate('messages.at(-1).elementKind'), 'relation');
      await click('[data-reader-fullscreen]');
      assert.equal(await evaluate(`!!document.querySelector('.is-expanded')`), true);
      await key('Escape', 27);
      assert.equal(await evaluate(`!!document.querySelector('.is-expanded')`), false);
      // A denied native API (as in embedded Webviews) still fills the viewport and inner renderer.
      await evaluate(`window.nativeRequestFullscreen=Element.prototype.requestFullscreen;Element.prototype.requestFullscreen=()=>Promise.reject(new Error('Denied by host'));document.querySelector('[data-reader-screen]').focus()`);
      await click('[data-reader-screen]');
      assert.equal(await evaluate(`document.querySelector('[data-reader-screen]').getAttribute('aria-pressed')`), 'true');
      assert.deepEqual(await evaluate(`(()=>{const r=document.querySelector('.is-fullscreen').getBoundingClientRect();return [r.x,r.y,r.width,r.height,innerWidth,innerHeight]})()`), [0, 0, width, 950, width, 950], 'fullscreen fills viewport');
      assert.equal(await evaluate(`document.querySelector('iframe').getBoundingClientRect().height > innerHeight * .5`), true, 'embedded renderer grows with viewport');
      assert.equal(await evaluateViewer(`document.documentElement.getAttribute('data-present')`), 'true', 'inner Archify enters presentation');
      await evaluateViewer(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
      await wait(`!document.querySelector('.is-fullscreen')`, 'Escape inside iframe exits fullscreen');
      assert.equal(await evaluate(`document.body.classList.contains('project-reader-fullscreen')`), false);
      assert.equal(await evaluate(`document.activeElement.matches('[data-reader-screen]')`), true, 'exit restores keyboard focus');
      await evaluate(`Element.prototype.requestFullscreen=window.nativeRequestFullscreen`);
      await click('[data-reader-export]');
      await wait(`messages.at(-1)?.type==='projectReaderExport'`, 'native SVG export');
      assert.match(await evaluate('messages.at(-1).content'), /<svg/);
      assert.equal(await evaluate('messages.at(-1).type'), 'projectReaderExport');
      await click('[data-project-check-knowledge]');
      await hostMessage({ type: 'projectKnowledgeChecked', checks: [{ id: 'run', fingerprint: ui.topicFingerprint(topics.find(t => t.id === 'run')), checkedAt: 10, state: 'changed', files: [{ path: evidence[0].path, state: 'changed' }] }] });
      await ready();
      assert.equal(await evaluate(`document.querySelector('[data-topic-check]').hidden`), false);
      assert.equal(await evaluate(`document.querySelector('.project-reader-figure').getBoundingClientRect().width >= document.querySelector('.project-reader-story').getBoundingClientRect().width * .95`), true, 'interactive view uses the reading width');
      await evaluate('window.scrollTo(0,0)');
      await writeFile(join(artifacts, `${theme}-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
      await click('[data-topic-diagram]');
      await hostMessage({ type: 'projectDiagramGenerating', active: true });
      await hostMessage({ type: 'projectDiagramProgress', message: 'Reading current code' });
      assert.equal(await evaluate(`!!document.querySelector('[data-reader-cancel]')`), true);
      await hostMessage({ type: 'projectDiagramGenerateFailed', error: 'Fixture failure' });
      await hostMessage({ type: 'projectDiagramGenerating', active: false });
      assert.equal(await evaluate(`document.querySelector('[data-reader-progress]').hidden`), false, 'failure remains visible');
      await click('[data-reader-inspector] [data-reader-topic="kernel"]').catch(() => click('.project-reader-directory [data-reader-topic="kernel"]'));
      await ready();
      assert.equal(await evaluate(`document.querySelector('[data-reader-article] h2').textContent`), 'Execution kernel');
      assert.equal(await evaluate(`document.querySelector('[data-reader-area="area.execution"]').open`), true, 'navigation opens the selected module area');
      await evaluate(`document.querySelector('[data-project-topic-search]').value='Workflow execution';document.querySelector('[data-project-topic-search]').dispatchEvent(new Event('input',{bubbles:true}))`);
      assert.equal(await evaluate(`document.querySelector('[data-reader-area="area.editing"]').hidden`), true);
      assert.equal(await evaluate(`document.querySelector('[data-reader-area="area.execution"]').open && !document.querySelector('[data-reader-area="area.execution"]').hidden`), true);
      await evaluate(`document.querySelector('[data-project-topic-search]').value='';document.querySelector('[data-project-topic-search]').dispatchEvent(new Event('input',{bubbles:true}))`);
      assert.equal(await evaluate(`document.querySelector('[data-reader-area="area.editing"]').hidden`), false, 'clearing search restores areas');
      await evaluate(`document.querySelector('[data-project-topic-search]').value='Run TypeScript';document.querySelector('[data-project-topic-search]').dispatchEvent(new Event('input',{bubbles:true}))`);
      assert.equal(await evaluate(`document.querySelectorAll('[data-topic-search]:not([hidden])').length`), 1);
      assert.deepEqual(await evaluate('violations'), [], 'reader respects CSP');
    }
  }
  await load('vscode-dark');
  await evaluate(`document.querySelector('[data-reader-screen]').click()`, true);
  await wait(`document.fullscreenElement===document.querySelector('.is-fullscreen') && !!document.fullscreenElement`, 'native fullscreen');
  await writeFile(join(artifacts, 'fullscreen-native.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  await evaluate(`document.exitFullscreen()`);
  await wait(`!document.querySelector('.is-fullscreen')`, 'browser fullscreen exit restores layout');
  await evaluate(`Element.prototype.requestFullscreen=()=>Promise.reject(new Error('Denied by host'))`);
  await click('[data-reader-fullscreen]');
  await click('[data-reader-screen]');
  await click('[data-reader-screen]');
  assert.equal(await evaluate(`!!document.querySelector('.is-expanded') && !document.querySelector('.is-fullscreen')`), true, 'exit restores previous expanded layout');
  await key('Escape', 27);
  await click('[data-reader-screen]');
  await evaluate(`document.querySelector('[data-reader-view]').dispatchEvent(new Event('change',{bubbles:true}))`);
  await ready();
  assert.equal(await evaluate(`!!document.querySelector('.is-fullscreen iframe')`), true, 'render reload retains fullscreen');
  assert.equal(await evaluateViewer(`document.documentElement.getAttribute('data-present')`), 'true', 'reloaded renderer retains presentation');
  await click('.project-reader-directory [data-reader-topic="kernel"]'); await ready();
  assert.equal(await evaluate(`!document.querySelector('.is-fullscreen') && !document.body.classList.contains('project-reader-fullscreen')`), true, 'navigation releases fullscreen');
  await click('.project-reader-directory [data-reader-topic="run"]'); await ready();
  await click('[data-reader-play]');
  assert.equal(await evaluate(`document.querySelector('[data-reader-play]').textContent`), 'Pause');
  await wait(`document.querySelector('[data-reader-play-status]').textContent==='Step 2 / 3'`, 'automatic playback');
  await click('[data-reader-play]');
  assert.equal(await evaluate(`document.querySelector('[data-reader-play]').textContent`), 'Play steps');
  await evaluateViewer(`Array.from(document.querySelectorAll('[data-node-id]')).find(n=>n.textContent.includes('Await calls')).setAttribute('data-route-journey-current','')`);
  await wait(`document.querySelector('[data-reader-section="settle"]').classList.contains('is-selected')`, 'native journey links to explanation');
  await evaluateViewer(`document.querySelectorAll('[data-route-journey-current]').forEach(n=>n.removeAttribute('data-route-journey-current'))`);
  await click('[data-reader-step="submit"]');
  await evaluateViewer(`Array.from(document.querySelectorAll('[data-node-id]')).find(n=>n.textContent.includes('Await calls')).setAttribute('data-route-journey-current','')`);
  await wait(`document.querySelector('[data-reader-section="settle"]').classList.contains('is-selected')`, 'restarted native journey');
  for (const fixture of diagrams) {
    await click(`[data-reader-diagram="${fixture.id}"]`); await ready();
    assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.renderer`), 'archify', fixture.kind);
    assert.equal(await evaluate(`document.querySelector('[data-reader-diagram-source]').closest('details').open`), false, 'saved model stays folded after a successful render');
    assert.equal(await evaluate(`document.querySelector('[data-reader-diagram-source]').textContent.trim().startsWith('{')`), true, 'saved model is shown as JSON');
    await evaluateViewer(`Array.from(document.querySelectorAll('[data-node-id]')).find(n=>n.textContent.includes('Code editor')).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
    await wait(`document.querySelector('[data-reader-inspector]').textContent.includes('Code editor')`, 'node inspection');
    await click('[data-reader-relation="request"]');
    await click('[data-reader-inspector] [data-reader-element-source]');
    assert.equal(await evaluate('messages.at(-1).elementId'), 'request');
  }
  failRender = true;
  await click('.project-reader-directory [data-reader-topic="run"]');
  await wait(`document.querySelector('[data-reader-canvas]')?.dataset.state==='error'`, 'explicit render error');
  assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.state`), 'error');
  assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.renderer`), undefined);
  assert.match(await evaluate(`document.querySelector('[data-reader-render-status]').textContent`), /Diagram unavailable: Fixture render failure\. The explanation and evidence remain available\./);
  assert.equal(await evaluate(`document.querySelectorAll('[data-reader-canvas] iframe, [data-reader-canvas] svg').length`), 0);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-reader-zoom], [data-reader-export]')).every(button => button.disabled)`), true, 'view controls are disabled without an interactive view');
  assert.equal(await evaluate(`document.querySelector('[data-reader-diagram-source]').closest('details').open`), true, 'saved model opens when the renderer fails');
  failRender = false;
  // Rapid switching while native renders resolve must leave only the last topic.
  await evaluate(`document.querySelector('[data-reader-topic="run"]').click();document.querySelector('[data-reader-topic="editor"]').click();document.querySelector('[data-reader-topic="kernel"]').click()`);
  await ready();
  assert.equal(await evaluate(`document.querySelector('[data-reader-article] h2').textContent`), 'Execution kernel');
  assert.equal(await evaluate(`document.querySelectorAll('[data-reader-canvas] iframe').length`), 1);
  await click('.project-reader-directory [data-reader-topic="c4:system_context:dext-system"]'); await ready();
  assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.renderer`), 'archify');
  assert.equal(await evaluateViewer(`Array.from(document.querySelectorAll('[data-node-id]')).some(n=>n.textContent.includes('Webview'))`), false);
  await evaluateViewer(`Array.from(document.querySelectorAll('[data-node-id]')).find(n=>n.textContent.includes('Dext system')).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await wait(`document.querySelector('[data-reader-inspector] [data-reader-topic="c4:containers:dext-system"]')`, 'C4 system selection');
  await click('[data-reader-inspector] [data-reader-topic="c4:containers:dext-system"]'); await ready();
  assert.equal(await evaluate(`document.querySelector('[data-reader-article] h2').textContent`), 'Runtime units');
  assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.renderer`), 'archify');
  await evaluateViewer(`Array.from(document.querySelectorAll('[data-node-id]')).find(n=>n.textContent.includes('Webview')).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  await wait(`document.querySelector('[data-reader-inspector]').textContent.includes('Chromium')`, 'C4 container selection');
  assert.match(await evaluate(`document.querySelector('[data-reader-inspector]').textContent`), /Chromium/);
  await click('[data-reader-inspector] [data-reader-topic="editor"]'); await ready();
  assert.equal(await evaluate(`document.querySelector('[data-reader-article] h2').textContent`), 'Code editor');
  await click('.project-reader-breadcrumb [data-reader-topic="c4:system_context:dext-system"]'); await ready();
  // The saved-model panel writes model strings as text, never as markup.
  failRender = true;
  const malicious = { ...diagrams[0], id: 'malicious', nodes: [node('unsafe', '<img src=x onerror="window.__projectReaderXss=1"> %%{init:{}}%%')] , relations: [], semantics: {} };
  await hostMessage({ type: 'projectDiagramGenerated', document: malicious });
  await click('[data-reader-diagram="malicious"]');
  await wait(`document.querySelector('[data-reader-canvas]')?.dataset.state==='error'`, 'malicious model error state');
  assert.equal(await evaluate(`window.__projectReaderXss || 0`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('[data-reader-diagram-source] img, [data-reader-diagram-source] script').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('[data-reader-canvas] img, [data-reader-canvas] script').length`), 0);
  assert.equal(await evaluate(`document.querySelector('[data-reader-diagram-source]').textContent.includes('<img')`), true, 'raw model text is retained but escaped');
  assert.equal(await evaluate(`document.querySelector('[data-reader-diagram-source]').closest('details').open`), true, 'failing model panel is expanded');
  failRender = false;
  if (process.argv.includes('--saved-project')) {
    const workspaceOption = process.argv.indexOf('--workspace');
    const savedRoot = workspaceOption < 0 ? '.' : process.argv[workspaceOption + 1];
    assert.ok(savedRoot && !savedRoot.startsWith('--'), '--workspace requires a directory');
    const savedIntent = ui.projectIntentSchema.parse(JSON.parse(await readFile(join(savedRoot, '.dext/project-intent.json'), 'utf8')));
    const savedDiagrams = await Promise.all((await readdir(join(savedRoot, '.dext/diagrams'))).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(savedRoot, '.dext/diagrams', name), 'utf8'))));
    const savedTopics = ui.buildProjectTopics(savedIntent, savedDiagrams);
    await load('vscode-dark', { ...data, readerDiagrams: savedDiagrams, architecture: { diagrams: savedDiagrams }, knowledge: { brief: savedIntent.brief.summary, topics: savedTopics } }, { topic: savedTopics[0].id });
    for (const topic of savedTopics) {
      await click(`.project-reader-directory [data-reader-topic="${topic.id}"]`); await ready();
      if (topic.qualityIssues?.some(issue => issue.status === 'retained' || issue.status === 'reassigned')) {
        assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-reader-article] details')).find(d=>d.querySelector('summary')?.textContent.startsWith('Explained ownership decisions'))?.open`), false, 'explained decisions stay folded');
      }
      if (topic.qualityIssues?.some(issue => issue.code === 'ownership-review' && (!issue.status || issue.status === 'unresolved'))) {
        assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-reader-article] details')).find(d=>d.querySelector('summary')?.textContent.startsWith('Ownership needs review'))?.open`), true, 'legacy and unresolved concerns stay visible');
      }
      if (await evaluate(`!!document.querySelector('[data-reader-article] [data-topic-evidence]')`)) {
        await click('[data-reader-article] [data-topic-evidence]');
        const request = await evaluate('messages.at(-1)');
        assert.equal(request.type, 'projectTopicEvidence');
        assert.equal(request.topicId, topic.id);
      }
    }
    const evolved = savedTopics.find(topic => topic.previousAnalyses?.length);
    if (evolved) {
      await click(`.project-reader-directory [data-reader-topic="${evolved.id}"]`); await ready();
      assert.match(await evaluate(`document.querySelector('[data-reader-article]').textContent`), /Earlier module analyses/);
      await writeFile(join(artifacts, 'historical-analysis-link.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
      await click('[data-reader-article] [data-reader-diagram]'); await ready();
      assert.match(await evaluate(`document.querySelector('[data-reader-article]').textContent`), /Review this historical analysis/);
      assert.equal(await evaluate(`!!document.querySelector('[data-reader-article] [data-reader-topic="${evolved.id}"]')`), true, 'historical diagram links back to its successor module');
    }
    for (const diagram of savedDiagrams) {
      await click(`[data-reader-diagram="${diagram.id}"]`); await ready();
      if (workspaceOption >= 0) {
        assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.renderer`), 'archify', 'generated temporary-workspace diagram renders natively');
        await click('[data-reader-fullscreen]');
        await new Promise(done=>setTimeout(done,200));
        await writeFile(join(artifacts, 'generated-module-analysis.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
        await key('Escape',27);
      }
      if (diagram.id === 'diagram.dext-architecture' || diagram.id === 'extension-activation-composition') {
        assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.renderer`), 'archify', 'actual Dext architecture must use native rendering');
        if (diagram.id === 'extension-activation-composition') {
          const points = await evaluateViewer(`document.querySelector('[data-edge-id="activation-creates-editor-tabs"]').getAttribute('data-composition-points').split(';').map(pair=>pair.split(',').map(Number))`);
          const ends = [points[0][1], points.at(-1)[1]];
          assert.ok(points.every(point => point[1] >= Math.min(...ends) && point[1] <= Math.max(...ends)), 'saved editor-tabs connection stops at its target without a dangling tail');
        }
        await click('[data-reader-fullscreen]');
        await new Promise(done=>setTimeout(done,200));
        await writeFile(join(artifacts, diagram.id === 'extension-activation-composition' ? 'extension-activation-routing.png' : 'dext-architecture-archify.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
        await key('Escape',27);
        if (diagram.id === 'extension-activation-composition') {
          await send('Emulation.setDeviceMetricsOverride', { width: 2048, height: 1240, deviceScaleFactor: 1, mobile: false });
          await click('[data-reader-screen]');
          await wait(`!!document.querySelector('.is-fullscreen')`, 'saved architecture fullscreen');
          await new Promise(done=>setTimeout(done,200));
          const clippedEdges = await evaluateViewer(`Array.from(document.querySelectorAll('[data-composition-points]')).filter(edge => {
            const box = edge.ownerSVGElement.viewBox.baseVal;
            return edge.getAttribute('data-composition-points').split(';').some(pair => {
              const [x,y] = pair.split(',').map(Number);
              return x < box.x || y < box.y || x + 8 > box.x + box.width || y + 8 > box.y + box.height;
            });
          }).map(edge => edge.getAttribute('data-edge-id'))`);
          assert.deepEqual(clippedEdges, [], 'all authored connection rails have room inside the fullscreen canvas');
          await writeFile(join(artifacts, 'extension-activation-canvas.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
          await key('Escape',27);
          await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
        }
      }
    }
    console.log(`PASS: existing workspace data (${savedTopics.length} topics, ${savedDiagrams.length} diagrams), read without migration or writes.`);
  }
  // New indexes browse without AI or phantom diagrams; explicit analysis publishes prose and graph together.
  const outlineIntent = ui.projectIntentSchema.parse({ schemaVersion: 1, updatedAt: 20, brief: { name: 'Dext', summary: 'Module index' }, contexts: [
    { id: 'code-module', canonicalName: 'Code module', purpose: 'Runs code', detail: 'outline', entryPoints: ['src/runner.ts'], sourceFiles: ['src/runner.ts', 'src/extension.ts'], evidence },
    { id: 'other-module', canonicalName: 'Other module', purpose: 'Other responsibility', detail: 'outline', entryPoints: ['src/other.ts'], evidence }
  ] });
  const outlineData = { ...data, readerDiagrams: [], architecture: { diagrams: [] }, knowledge: { brief: 'Module index', topics: ui.buildProjectTopics(outlineIntent) } };
  await load('vscode-dark', outlineData, { topic: 'code-module' });
  assert.match(await evaluate(`document.querySelector('[data-reader-analysis-state]').textContent`), /Not analyzed/);
  assert.equal(await evaluate('messages.length'), 0, 'opening an outline never starts AI or rendering');
  assert.equal(await evaluate(`document.querySelector('[data-topic-diagram]').textContent`), 'Analyze this module');
  assert.match(await evaluate(`document.querySelector('[data-reader-article]').textContent`), /Files in this module · 2/);
  assert.match(await evaluate(`document.querySelector('[data-reader-article]').textContent`), /src\/extension\.ts/);
  await click('[data-topic-diagram]');
  assert.deepEqual(await evaluate('messages.at(-1)'), { type: 'projectTopicDiagram', topicId: 'code-module' });
  await hostMessage({ type: 'projectDiagramGenerating', active: true });
  await click('.project-reader-directory [data-reader-topic="other-module"]');
  const analysis = { ...diagram('architecture'), id: 'module-detail', updatedAt: 21, metadata: { topicId: 'code-module', topicAnalysis: 1, topicBasis: outlineData.knowledge.topics[0].basis, topicSummary: 'The editor sends code to the execution kernel.' },
    nodes: [node('editor', 'Code editor', { description: 'Collects submitted code.', semanticIds: ['editor', 'code-module'] }), node('kernel', 'Execution kernel', { description: 'Executes the submitted module.', semanticIds: ['kernel', 'code-module'] })] };
  currentData = { ...outlineData, readerDiagrams: [analysis], knowledge: { ...outlineData.knowledge, topics: ui.buildProjectTopics(outlineIntent, [analysis]) } };
  await hostMessage({ type: 'projectDiagramGenerated', document: analysis, topics: currentData.knowledge.topics });
  await hostMessage({ type: 'projectDiagramGenerating', active: false });
  assert.equal(await evaluate(`document.querySelector('[data-reader-article] h2').textContent`), 'Other module', 'late analysis cannot switch the selected module');
  await click('.project-reader-directory [data-reader-topic="code-module"]'); await ready();
  assert.match(await evaluate(`document.querySelector('[data-reader-section="code-module"]').textContent`), /editor sends code/);
  assert.match(await evaluate(`document.querySelector('[data-reader-section="kernel"]').textContent`), /Executes the submitted module/);
  assert.equal(await evaluate(`document.querySelector('[data-reader-canvas]').dataset.renderer`), 'archify');
  await click('[data-reader-step="kernel"]');
  assert.equal(await evaluate(`document.querySelector('[data-reader-section="kernel"]').classList.contains('is-selected')`), true);
  await hostMessage({ type: 'projectDiagramGenerateFailed', error: 'Analysis failed; saved explanation remains.' });
  assert.match(await evaluate(`document.querySelector('[data-reader-section="code-module"]').textContent`), /editor sends code/);
  await evaluate('window.scrollTo(0,0)');
  await writeFile(join(artifacts, 'module-analysis.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  // Conversation forms call the shared renderer before attaching their fragment to the document.
  const markdownBundle = await build({ stdin: { contents: 'export { renderMarkdownDiagrams } from "./src/platform/browser/markdownDiagrams.ts";', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'MarkdownDiagramCheck' });
  await evaluate(markdownBundle.outputFiles[0].text);
  await evaluate(`{const root=document.createElement('section');for(const source of ['flowchart TD\\n A[Start] --> B[Done]','flowchart TD\\n A[unfinished','classDiagram\\n class Example']){const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-mermaid';code.textContent=source;pre.append(code);root.append(pre);}MarkdownDiagramCheck.renderMarkdownDiagrams(root);document.body.replaceChildren(root);}`);
  await wait(`document.querySelectorAll('[data-diagram-state]').length===3`, 'detached Markdown rendering');
  assert.equal(await evaluate(`document.querySelectorAll('[data-diagram-state=ready] svg').length`), 2);
  assert.equal(await evaluate(`document.querySelector('[data-diagram-state=error] details').open`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.markdown-diagram-staging').length`), 0);
  console.log('PASS: Project reader uses Archify for all five kinds, with model/prose/source links, CSP, ownership, export, explicit render errors and responsive themes. Screenshots: .tmp-tb/project-reader-ui');
} finally {
  server?.close();
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
