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
  const mermaidBundle = await build({ entryPoints: ["src/webview/mermaid.ts"], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true, logLevel: "silent" });
  const mermaidScript = mermaidBundle.outputFiles[0].text;
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
    const url = request.url ?? '';
    response.setHeader('Content-Type', url === '/style.css' ? 'text/css' : url === '/project.js' || url === '/mermaid.js' ? 'application/javascript' : 'text/html');
    response.end(url === '/style.css' ? themeCss + css : url === '/project.js' ? js : url === '/mermaid.js' ? mermaidScript : pageHtml);
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
  const treeDiagram = { ...diagram('tree'), title: 'tree saved view', nodes: [node('editor', 'Code editor'), node('kernel', 'Execution kernel', { role: 'store', parentId: 'editor' })], relations: [], semantics: undefined };
  const classDiagram = { ...diagram('class'), title: 'class saved view', nodes: [
    { ...node('editor', 'Code editor'), classKind: 'class', members: [{ name: 'submit', kind: 'method', returns: 'void' }] },
    { ...node('kernel', 'Execution kernel', { role: 'store' }), classKind: 'interface', members: [{ name: 'execute', kind: 'method', returns: 'void' }] }
  ], relations: [{ ...relation('implements', 'editor', 'kernel'), kind: 'realization' }], semantics: undefined };
  diagrams.push(treeDiagram, classDiagram);
  intent.c4 = { systemId: 'dext-system', elements: [
    { id: 'dext-system', name: 'Dext system', kind: 'system', description: 'Development assistant', contextIds: [], evidence },
    { id: 'developer', name: 'Developer', kind: 'person', description: 'Runs tasks', contextIds: [], evidence },
    { id: 'webview', name: 'Webview', kind: 'container', parentId: 'dext-system', description: 'Browser UI', technology: 'Chromium', contextIds: ['editor'], evidence },
    { id: 'extension', name: 'Extension host', kind: 'container', parentId: 'dext-system', description: 'Hosts execution', technology: 'Node.js', contextIds: ['kernel'], evidence }
  ], relationships: [
    { id: 'uses-dext', from: 'developer', to: 'dext-system', description: 'Uses assistant', evidence },
    { id: 'posts-command', from: 'webview', to: 'extension', description: 'Sends commands', evidence }
  ] };
  const topics = [...ui.buildProjectTopics(intent, diagrams), {
    id: 'structure:map', title: 'Structure map', kind: 'structure', analysisState: 'ready', description: 'Physical module and file layout.', responsibilities: [], entryPoints: [], steps: [], constraints: [], evidence: [evidence[0]], diagrams: [], review: 'derived', diagram: treeDiagram
  }, {
    id: 'structure:types', title: 'Type map', kind: 'types', analysisState: 'ready', description: 'Explicit types and members.', responsibilities: [], entryPoints: [], steps: [], constraints: [], evidence: [evidence[0]], diagrams: [], review: 'derived', diagram: classDiagram
  }];
  const data = { overview: { name: 'Dext', root: '.', objects: 0, accepted: 0, drafts: 0, needsVerification: 0, initialization: { status: 'completed' } }, objects: [], architecture: { diagrams }, readerDiagrams: diagrams, knowledge: { brief: intent.brief.summary, topics } };
  const artifacts = resolve('.tmp-tb/project-reader-ui'); await mkdir(artifacts, { recursive: true });
  const wait = async (expression, label) => { for (let i = 0; i < 600; i++) { if (await evaluate(expression)) return; await new Promise(done => setTimeout(done, 50)); } throw new Error(`${label}: ${JSON.stringify(await evaluate(`({status:document.querySelector('[data-reader-render-status]')?.textContent,messages:window.messages,violations:window.violations,frame:document.querySelector('iframe')?.srcdoc.length})`))}`); };
  const ready = () => wait(`document.querySelector('[data-reader-canvas]')?.dataset.state==='ready' || (!document.querySelector('[data-reader-canvas]') && !!document.querySelector('[data-reader-analysis-state]'))`, 'Diagram did not render');
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
  const hostMessage = (message) => evaluate(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(message)}}))`);
  const load = async (theme, pageData = data, filters = { topic: 'run' }, page = 'knowledge') => {
    currentData = pageData;
    const light = theme === 'vscode-light';
    themeCss = `:root{--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-editor-background:${light ? '#fff' : '#1e1e1e'};--vscode-foreground:${light ? '#333' : '#ddd'};--vscode-descriptionForeground:${light ? '#555' : '#bbb'};--vscode-input-background:${light ? '#eee' : '#313131'};--vscode-input-foreground:${light ? '#333' : '#ddd'};--vscode-panel-border:${light ? '#ddd' : '#555'};--vscode-focusBorder:#0088ff;--vscode-list-activeSelectionBackground:#004c80;--vscode-list-activeSelectionForeground:#fff;--vscode-button-secondaryBackground:${light ? '#eee' : '#313131'};--vscode-textBlockQuote-background:${light ? '#eee' : '#292929'}}`;
    pageHtml = ui.renderEditorTabHtml(`<script>document.body.classList.add('${theme}');window.messages=[];window.violations=[];document.addEventListener('securitypolicyviolation',e=>violations.push({directive:e.violatedDirective,blocked:e.blockedURI,source:e.sourceFile,line:e.lineNumber}));window.state={filters:${JSON.stringify(filters)}};window.acquireVsCodeApi=()=>({postMessage:m=>{messages.push(m);projectHostMessage(JSON.stringify(m))},getState:()=>state,setState:s=>{state=s}});</script>` + ui.renderProjectPanel(page, pageData, { state: { key: 'dext.editor:project', page, filters, restoreVersion: 1 } }), `${origin}/style.css`, origin, { embedFrames: page === 'knowledge' || page === 'architecture', scriptUri: `${origin}/project.js`, mermaidUri: `${origin}/mermaid.js` });
    await send('Page.navigate', { url: `${origin}/?${Date.now()}` });
    await wait(`document.readyState==='complete' && !!window.messages && !!document.querySelector('.project-panel')`, 'reader load');
    if ((page === 'knowledge' || page === 'architecture') && filters.topic !== '') await ready();
  };
  const native = { schemaVersion: 1, revision: 7, updatedAt: 0, nodes: [
    { id: 'contract', kind: 'contract', title: 'API contract', canonicalName: 'API', review: 'accepted', freshness: 'current', body: { kind: 'inline', text: '## Responsibility\n\n- **Stable** `interface`\n\n<script>window.unsafeNorm=true</script>' } },
    { id: 'kernel', kind: 'module', title: 'Execution kernel', canonicalName: 'Kernel', review: 'draft', freshness: 'needs_verification', body: { kind: 'inline', text: '## Responsibility\n\n- **Runs** modules' } },
    { id: 'document', kind: 'architecture', title: 'Architecture', canonicalName: 'Architecture', review: 'draft', body: { kind: 'document', path: 'docs/architecture.md', contentHash: 'saved' } }
  ], relations: [{ id: 'link', from: 'kernel', to: 'document', kind: 'depends_on' }] };
  // A norm is maintained in the article that renders it: no second page, no copied text.
  await load('vscode-dark', { ...data, model: native }, { topic: 'kernel' }, 'knowledge');
  assert.equal(await evaluate("document.querySelectorAll('[data-native-knowledge]').length"), 0, 'there is no separate norms page');
  assert.equal(await evaluate(`document.querySelectorAll('[data-norm]').length`), 1, 'only the module being read folds in a norm');
  assert.equal(await evaluate(`document.querySelector('[data-norm="kernel"]').open`), false, 'the norm block starts folded');
  assert.equal(await evaluate(`document.querySelector('[data-reader-article] .project-markdown').textContent.includes('Execute TypeScript')`), true, 'the article keeps its module explanation');
  assert.equal(await evaluate(`document.querySelectorAll('[data-reader-article] .project-markdown').length`), 1, 'the norm text is not rendered a second time');
  assert.equal(await evaluate("!!window.unsafeNorm"), false, 'Markdown cannot execute HTML');
  await click('[data-norm="kernel"] > summary');
  assert.equal(await evaluate(`document.querySelector('[data-norm="kernel"]').open`), true, 'the block opens from its own summary');
  assert.equal(await evaluate(`document.querySelector('[data-norm="kernel"] textarea').value.includes('**Runs**')`), true, 'the source stays editable in place');
  await evaluate(`document.querySelector('[data-norm="kernel"] textarea').value='Revised interface'`);
  await click('[data-norm="kernel"] [data-knowledge-save]');
  assert.deepEqual(await evaluate('messages.at(-1)'), { type: 'projectKnowledgeUpdate', revision: 7, action: 'body', id: 'kernel', text: 'Revised interface' });
  assert.equal(await evaluate('state.filters.spec'), 'kernel', 'the reopened block follows its own write');
  await click('[data-norm="kernel"] [data-knowledge-confirm]');
  assert.equal((await evaluate('messages.at(-1)')).action, 'confirm');
  await click('[data-norm="kernel"] [data-knowledge-unlink]');
  assert.equal((await evaluate('messages.at(-1)')).action, 'unlink');
  await evaluate("document.querySelector('[data-norm=kernel] [data-knowledge-to]').value='contract';document.querySelector('[data-norm=kernel] [data-spec-link]').requestSubmit()");
  assert.deepEqual(await evaluate('messages.at(-1)'), { type: 'projectKnowledgeUpdate', revision: 7, action: 'link', from: 'kernel', to: 'contract', kind: 'contains' });
  // A norm no article covers is maintained from the introduction, still on the same page.
  await load('vscode-dark', { ...data, model: native }, { topic: '' }, 'knowledge');
  await wait(`document.querySelector('[data-reader-article] h2')?.textContent==='Project introduction'`, 'introduction');
  assert.equal(await evaluate(`!!document.querySelector('[data-norm="contract"]')`), true, 'uncovered norms live on the introduction');
  assert.equal(await evaluate("!!window.unsafeNorm"), false, 'uncovered norms cannot execute HTML either');
  await click('[data-norm="contract"] > summary');
  await click('[data-norm="contract"] [data-knowledge-confirm]');
  assert.equal((await evaluate('messages.at(-1)')).action, 'confirm');
  await click('[data-norm="document"] [data-knowledge-adopt]');
  assert.equal((await evaluate('messages.at(-1)')).action, 'adopt');
  await click('[data-norm="document"] [data-knowledge-open]');
  assert.deepEqual(await evaluate('messages.at(-1)'), { type: 'projectKnowledgeOpen', nodeId: 'document' });
  for (const width of [390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await load('vscode-dark', { ...data, model: native }, { topic: 'kernel', spec: 'kernel' }, 'knowledge');
    assert.equal(await evaluate(`document.querySelector('[data-norm="kernel"]').open`), true, 'the block reopens after its own write');
    assert.equal(await evaluate("document.querySelector('.project-directory-disclosure').open"), width > 900, 'directory folds at narrow editor widths');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'the article fits the editor width');
    assert.deepEqual(await evaluate('violations'), [], 'the norm block stays within the editor CSP');
    await writeFile(join(artifacts, `norm-${width}.png`), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  }
  const qualityIssues = [
    { code: 'community-split', message: '检查 <entry> & "边界"', contextIds: [], elementIds: [], sourcePaths: ['src/fallback.ts'], reason: '保留完整原因', evidence: [{ path: 'src/runner.ts', line: 12 }] },
    { code: 'ownership-review', message: 'Review ownership', contextIds: [], elementIds: [], sourcePaths: ['src/editor.ts'] }
  ];
  const qualityTopic = { ...topics.find(topic => topic.id === 'run'), qualityIssues };
  await load('vscode-dark', { ...data, knowledge: { ...data.knowledge, topics: [qualityTopic] } });
  assert.equal(await evaluate(`document.querySelectorAll('[data-project-quality-copy]').length`), 2);
  await evaluate(`document.querySelector('[data-project-quality-copy]').click()`);
  const copyRequest = await evaluate(`messages.at(-1)`);
  assert.equal(copyRequest.type, 'projectQualityCopy');
  assert.equal(copyRequest.text, '# Run TypeScript\n\n## Architecture issues\n\n1. 检查 <entry> & "边界"\n   Code: community-split\n   Reason: 保留完整原因\n   - src/runner.ts:12');
  assert.equal(await evaluate(`document.querySelector('[data-project-quality-copy]').closest('details').open`), true, 'copy does not toggle the group');
  await hostMessage({ type: 'projectQualityCopied', requestId: copyRequest.requestId, success: true });
  assert.equal(await evaluate(`document.querySelector('[data-project-quality-copy]').textContent`), 'Copied');
  await evaluate(`document.querySelectorAll('[data-project-quality-copy]')[1].click()`);
  const reviewRequest = await evaluate(`messages.at(-1)`);
  assert.match(reviewRequest.text, /Ownership needs review[\s\S]*Review ownership[\s\S]*src\/editor.ts/);
  await hostMessage({ type: 'projectQualityCopied', requestId: reviewRequest.requestId, success: false });
  assert.equal(await evaluate(`document.querySelectorAll('[data-project-quality-copy]')[1].textContent`), 'Copy failed');
  assert.equal(await evaluate(`document.querySelectorAll('[data-project-quality-copy]')[1].disabled`), false, 'failed copy can be retried');
  for (const width of [320, 1400]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false });
    await load('vscode-dark', { ...data, overview: { ...data.overview, qualityIssues } }, {}, 'overview');
    await evaluate(`document.querySelector('[data-project-quality-copy]').click()`);
    const overviewCopy = await evaluate('messages.at(-1)');
    assert.equal(overviewCopy.type, 'projectQualityCopy', 'overview copy works without the reader');
    assert.match(overviewCopy.text, /Architecture issues[\s\S]*src\/runner.ts:12/);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'overview copy fits viewport');
  }
  // Project settings are label/control rows. A generic form-label rule used to win
  // over the AI row grid, which stacked and centred every control, and a full-width
  // rule stretched every checkbox across the row.
  const settingsOverview = {
    ...data.overview,
    workspaceSettings: { planDirectory: '.dext/plans', apiDirs: ['.dext/api'], skillDirs: ['.dext/skills'], mcpDirs: ['.dext/mcp'] },
    evidenceSettings: { depth: 'whole', files: 1000, chars: 1_200_000, fileChars: 200_000, include: [] },
    workspaceSettingsVersion: 3,
    evidenceSettingsVersion: 3,
    toolSettings: { structureQuery: true, projectQuery: true },
    aiCli: [{ id: 'pi', label: 'Pi CLI', models: [{ id: 'deepseek', label: 'DeepSeek', group: 'myproxy' }] }],
    selectedAiCli: 'pi',
    selectedAiModel: 'deepseek'
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  await load('vscode-dark', { ...data, overview: settingsOverview }, {}, 'overview');
  await click('.project-workspace-settings summary');
  const settingRows = await evaluate(`['.project-ai-cli','.project-ai-model'].map((selector) => {
    const label = document.querySelector(selector);
    const control = label.lastElementChild.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(label.firstChild);
    const text = range.getBoundingClientRect();
    return { selector, height: Math.round(label.getBoundingClientRect().height), beside: control.left >= text.right, aligned: Math.abs(control.top - text.top) <= 12 };
  })`);
  for (const row of settingRows) {
    assert.ok(row.beside && row.aligned, `${row.selector} keeps its control beside the label: ${JSON.stringify(row)}`);
    assert.ok(row.height <= 48, `${row.selector} stays one row: ${JSON.stringify(row)}`);
  }
  assert.ok((await evaluate(`Array.from(document.querySelectorAll('.project-checkbox-field input')).map((input) => Math.round(input.getBoundingClientRect().width))`)).every((width) => width <= 20), 'checkboxes keep their native size');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-settings-summary-hint')).display`), 'none', 'the expand hint disappears once expanded');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'settings fit the editor width');
  await writeFile(join(artifacts, 'overview-settings.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast']) {
    for (const width of [320, 1400]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: false });
      await load(theme);
      assert.equal(await evaluate(`document.querySelector('[data-reader-article] h2').textContent`), 'Run TypeScript', 'restore selected topic');
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, 'reader fits viewport');
      assert.equal(await evaluate(`(()=>{const a=[...document.querySelectorAll('.project-reader-directory [aria-current="page"]')];return a.length===1&&a[0].dataset.readerTopic==='run'})()`), true, 'one directory entry is current');
      assert.equal(await evaluate(`!document.querySelector('[data-reader-aside]')`), true, 'the reader has no reading rail beside the article');
      assert.equal(await evaluate(`(()=>{const m=document.querySelector('.project-reader-main').getBoundingClientRect();const s=document.querySelector('.project-reader').getBoundingClientRect();return m.right>=s.right-2&&m.right>s.left+m.width*.6})()`), true, 'the article fills the reader width');
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
      const layout = await evaluate(`(() => {
        const main = document.querySelector('.project-reader-main');
        const figure = document.querySelector('.project-reader-figure');
        const prose = document.querySelector('.project-reader-prose');
        const art = document.querySelector('[data-reader-article]').getBoundingClientRect(), left = prose.getBoundingClientRect(), right = figure.getBoundingClientRect();
        const docked = !!figure.closest('.project-reader-diagram-pane');
        return { grid: getComputedStyle(main).display === 'grid', docked, position: getComputedStyle(docked ? figure.parentElement : figure).position, beside: right.left >= left.right - 1, below: right.top >= left.bottom - 1, figure: Math.round(right.width), main: Math.round(main.getBoundingClientRect().width), article: Math.round(art.width) };
      })()`);
      if (width >= 1360) {
        assert.equal(layout.grid, true, 'a wide editor sets the diagram beside the explanation');
        assert.equal(layout.docked, true, 'the diagram is docked beside the article');
        assert.equal(layout.beside, true, `the diagram sits right of the explanation: ${JSON.stringify(layout)}`);
        assert.equal(layout.position, 'sticky', 'the diagram stays in view while the explanation scrolls');
        assert.ok(layout.figure >= 360, `the diagram column keeps a usable width: ${JSON.stringify(layout)}`);
        assert.ok(layout.figure < layout.main * .6, `the diagram does not take the whole reader: ${JSON.stringify(layout)}`);
      } else {
        assert.equal(layout.grid, false, 'a narrow editor stacks the explanation and its diagram');
        assert.equal(layout.docked, false, 'a narrow editor keeps the diagram between the explanation and the steps');
        assert.equal(layout.below, true, `the diagram follows the explanation in one column: ${JSON.stringify(layout)}`);
        assert.ok(Math.abs(layout.figure - layout.article) <= 2, `the stacked diagram uses the article width: ${JSON.stringify(layout)}`);
      }
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
      await click('[data-reader-home]');
      assert.equal(await evaluate(`(()=>{const a=[...document.querySelectorAll('.project-reader-directory [aria-current="page"]')];return a.length===1&&a[0].hasAttribute('data-reader-home')})()`), true, 'the introduction marks only its own entry current');
      assert.equal(await evaluate(`!!document.querySelector('[data-project-freshness]')`), true, 'the introduction summarizes how fresh the saved explanations are');
      assert.match(await evaluate(`document.querySelector('[data-project-freshness]').textContent`), /1 of 1 modules changed/, 'the summary counts the modules the last check found changed');
      assert.match(await evaluate(`document.querySelector('[data-project-freshness]').textContent`), /last checked/i, 'the summary names the check time');
      // Dependencies are read first: the fixture's editor depends on the kernel.
      const readingSteps = await evaluate(`[...document.querySelectorAll('[data-reading-step]')].map(b=>[Number(b.dataset.readingStep), b.dataset.readerTopic])`);
      assert.deepEqual(readingSteps.map(([, id]) => id).sort(), [...new Set(readingSteps.map(([, id]) => id))].sort(), 'every topic appears once in Start here');
      assert.deepEqual(readingSteps.map(([step]) => step), readingSteps.map((_, index) => index + 1), 'the steps are numbered in order');
      const stepIds = readingSteps.map(([, id]) => id);
      assert.ok(stepIds.indexOf('kernel') < stepIds.indexOf('editor'), `the reused module is read before the module that depends on it: ${JSON.stringify(stepIds)}`);
      await click('.project-reader-directory [data-reader-topic="kernel"]'); await ready();
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
  // The split waits for a wide editor: at a normal half-screen editor the diagram stays in the reading column.
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 950, deviceScaleFactor: 1, mobile: false });
  await load('vscode-dark');
  await ready();
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-reader-main')).display`), 'block', 'the split waits for a wide editor');
  assert.equal(await evaluate(`!!document.querySelector('[data-reader-article] > .project-reader-figure, [data-reader-article] > .project-reader-tail > .project-reader-figure')`), true, 'the diagram stays in the article below the split');
  assert.equal(await evaluate(`(()=>{const f=document.querySelector('.project-reader-figure').getBoundingClientRect();const a=document.querySelector('[data-reader-article]').getBoundingClientRect();return Math.abs(f.width-a.width)<=2&&f.top>document.querySelector('.project-reader-prose').getBoundingClientRect().bottom-1})()`), true, 'the stacked diagram uses the article width below the explanation');
  assert.equal(await evaluate(`document.querySelector('.project-reader-main').getBoundingClientRect().right >= document.querySelector('.project-reader').getBoundingClientRect().right - 2`), true, 'the article fills the reader width without a rail');
  await writeFile(join(artifacts, 'reader-1100.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  // A fullscreen editor spends every pixel past the prose measure on the diagram.
  await send('Emulation.setDeviceMetricsOverride', { width: 2400, height: 1400, deviceScaleFactor: 1, mobile: false });
  await load('vscode-dark');
  await ready();
  const wide = await evaluate(`(() => {
    const article = document.querySelector('[data-reader-article]');
    const figure = document.querySelector('.project-reader-figure').getBoundingClientRect();
    const prose = document.querySelector('.project-reader-prose').getBoundingClientRect();
    return { figure: Math.round(figure.width), prose: Math.round(prose.width), article: Math.round(article.getBoundingClientRect().width), panel: Math.round(document.querySelector('.project-panel').getBoundingClientRect().width) };
  })()`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-reader-main')).display`), 'grid', 'a fullscreen editor keeps the diagram beside the explanation');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.project-reader-diagram-pane')).position`), 'sticky', 'the docked diagram stays in view');
  assert.ok(wide.panel <= 1904 && wide.article <= wide.panel, `the reader stops at its reading cap: ${JSON.stringify(wide)}`);
  assert.ok(wide.prose >= wide.article * .3 && wide.prose <= 720, `the prose keeps its measure while the diagram grows: ${JSON.stringify(wide)}`);
  assert.ok(wide.figure > wide.prose, `the diagram takes the width past the prose: ${JSON.stringify(wide)}`);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'the wide reader does not overflow');
  assert.equal(await evaluate(`(()=>{const h=document.querySelector('.project-workspace-header').getBoundingClientRect();const r=document.querySelector('.project-reader').getBoundingClientRect();return Math.abs(h.left-r.left)<2&&Math.abs(h.right-r.right)<2})()`), true, 'the reader and its workspace header share one frame');
  await writeFile(join(artifacts, 'reader-2400.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  // Crossing the breakpoint re-parents the one rendered diagram instead of duplicating it.
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 950, deviceScaleFactor: 1, mobile: false });
  await new Promise(done => setTimeout(done, 250));
  assert.equal(await evaluate(`!!document.querySelector('[data-reader-article] > .project-reader-figure')`), true, 'narrowing the editor returns the diagram to the article');
  assert.equal(await evaluate(`document.querySelectorAll('.project-reader-figure').length`), 1, 'undocking keeps a single diagram');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 950, deviceScaleFactor: 1, mobile: false });
  await new Promise(done => setTimeout(done, 250));
  assert.equal(await evaluate(`!!document.querySelector('.project-reader-diagram-pane > .project-reader-figure')`), true, 'widening the editor docks the diagram again');
  assert.equal(await evaluate(`document.querySelectorAll('.project-reader-figure').length`), 1, 're-docking keeps a single diagram');
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
    if (fixture.relations.length) {
      await click('[data-reader-relation="request"]').catch(() => click(`[data-reader-relation="${fixture.relations[0].id}"]`));
      await click('[data-reader-inspector] [data-reader-element-source]');
      assert.equal(await evaluate('messages.at(-1).elementId'), fixture.relations[0].id);
    }
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
  console.log('PASS: Project reader uses Archify for all seven kinds, with model/prose/source links, CSP, ownership, export, explicit render errors and responsive themes. Screenshots: .tmp-tb/project-reader-ui');
} finally {
  server?.close();
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
