import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runWebviewChecks } from './monaco-ref-lab/check.mjs';
import { readSidebarBody } from './monaco-ref-lab/serve.mjs';

// Run after npm run build. Production Conversation bundle and History renderer,
// with a mocked VS Code message bridge; this is not a VS Code host acceptance test.
const historyBundle = await build({ entryPoints: ['src/features/conversations/presentation/historyRender.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const historyModule = { exports: {} };
new Function('require', 'module', 'exports', historyBundle.outputFiles[0].text)(createRequire(import.meta.url), historyModule, historyModule.exports);
const { renderHistoryRecord } = historyModule.exports;
// The shared Mermaid bundle is a separate Webview entry; loading it here is what a
// real page does when the first diagram appears.
const mermaidBundle = await build({ entryPoints: ['src/webview/mermaid.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', minify: true, logLevel: 'silent' });
const diagramsBundle = await build({ entryPoints: ['src/webview/diagrams.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', minify: true, logLevel: 'silent' });
const raw = ' \r\n' + JSON.stringify({ 中文: '第一行\n"引号" C:\\path **bold** `code` <img src=x>', nested: [{ long: 'x'.repeat(8000) }] }) + '\r\n ';
const command = 'powershell -NoProfile -EncodedCommand ' + Buffer.from('Write-Output "中文"', 'utf16le').toString('base64').repeat(500);
const execution = (result) => ({ invocation: { kind: 'invocation', method: result.kind, source: 'code', arguments: [] },
  method: { id: result.kind, title: result.kind, kind: 'command', source: 'builtin' }, result, durationMs: 1 });
const response = { kind: 'workflow', executions: [execution({ kind: 'ask', text: raw }), execution({ kind: 'terminal', command,
  cwd: 'C:\\' + 'long-path'.repeat(200), stdout: 'ok', stderr: '', status: 'succeeded', exit_code: 0, duration_ms: 1 }),
  execution({ kind: 'ask', text: '# Ordinary Markdown\n\n**still bold**\n\n```mermaid\nflowchart TD\n A[打开宠物] --> B[完成]\n```' }),
  execution({ kind: 'ask', text: '{invalid JSON}' })] };
const usageEvents = [{ phase: 'status', text: '', usage: { totalTokens: 900 } },
  { phase: 'status', text: '', usage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 234 } }];
const commandEvent = { phase: 'tool', id: 'three', solo: true, text: command };
const record = { id: 't1', createdAt: 1, input: 'structured output', mode: 'code', process: [
  ...usageEvents, { phase: 'message', text: 'Historical trace' }, commandEvent
], output: JSON.stringify(response) };

await runWebviewChecks(async ({ evaluate, settle, send, click }) => {
  const body = await readSidebarBody();
  await evaluate(`document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.messages=[];
    window.acquireVsCodeApi=()=>({postMessage:m=>{messages.push(m);if(m.type==='clipboardWrite')queueMicrotask(()=>host({type:'clipboardWriteResult',requestId:m.requestId,success:true}));},getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  await evaluate(mermaidBundle.outputFiles[0].text);
  await evaluate(diagramsBundle.outputFiles[0].text);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/webview/main.css', 'utf8'))};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  await evaluate(`window.selection={profileId:'codex',permission:'full-access',model:'test-model',reasoningEffort:'',speed:'',serviceTier:''};
    host({type:'state',state:{methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[{id:'codex',provider:'codex',label:'Codex CLI',command:'codex',models:['test-model']}],agentSelection:selection}});
    host({type:'conversations',sessions:[{id:'active',title:'JSON',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'active',selection,planStatus:'new',hostInitiated:true});
    host({type:'executing',value:true,sessionId:'active',turnId:'t1',source:'structured output',mode:'code',startedAt:Date.now()});
    host({type:'agentEvents',sessionId:'active',events:[...${JSON.stringify(usageEvents)},{phase:'message',id:'partial',text:'{"partial":'}]});`);
  await settle();
  const processSummary = '[data-turn-section="process"] > summary';
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(processSummary)}).textContent`), /1\.2k tokens/, 'live usage');
  assert.equal(await evaluate(`document.querySelectorAll('.json-output').length`), 0, 'incomplete streaming output is not JSON');
  assert.ok(await evaluate(`document.getElementById('result').textContent.includes('{"partial":')`), 'incomplete stream stays visible');
  assert.equal(await evaluate(`document.querySelectorAll('.agent-stream-item .markdown-diagram').length`), 0, 'a streaming row renders no diagram mid-fence');
  await evaluate(`host({type:'agentEvents',sessionId:'active',events:[{phase:'message',id:'final',text:${JSON.stringify('```mermaid\nflowchart TD\n A[过程] --> B[完成]\n```')},replace:true,done:true}]});`);
  assert.equal(await evaluate(`new Promise(resolve=>{const deadline=Date.now()+15000;const check=()=>{if(document.querySelector('.agent-stream-item [data-diagram-state=ready] svg'))resolve(true);else if(Date.now()>deadline)resolve(false);else setTimeout(check,50);};check();})`), true, 'a finished Process message renders its diagram');
  assert.equal(await evaluate(`document.querySelector('.agent-stream-item [data-diagram-state=ready] svg').textContent.includes('过程')`), true);
  await evaluate(`host({type:'agentEvents',sessionId:'active',events:[
    {phase:'tool',id:'one',groupId:'tools',groupLabel:'Tools',title:'First',text:'start'},
    {phase:'tool',id:'two',groupId:'tools',title:'Second',text:'other'},
    {phase:'message',id:'between',text:'Following the group',done:true},
    ${JSON.stringify(commandEvent)}
  ]});`);
  await settle();
  const commandState = await evaluate(`(() => {
    document.querySelector('[data-turn-section="process"]').open=true;
    const group=document.querySelector('.agent-trace-tool');
    group.open=true;
    window.firstCommand=group.querySelector('.agent-trace-command');
    firstCommand.open=true;
    firstCommand.querySelector('summary').focus();
    return {title:group.querySelector('.agent-stream-summary-label').textContent,
      grouped:group.querySelectorAll('.agent-trace-command').length,
      standalone:document.querySelectorAll('.agent-stream-panel > .agent-trace-command').length};
  })()`);
  assert.deepEqual(commandState, { title: 'Tools', grouped: 2, standalone: 1 });
  await evaluate(`host({type:'agentEvents',sessionId:'active',events:[{phase:'tool',id:'one',groupId:'tools',text:' + more'}]});`);
  await settle();
  assert.deepEqual(await evaluate(`({
    same: document.querySelector('.agent-trace-tool .agent-trace-command')===firstCommand,
    open: firstCommand.open,
    focused: document.activeElement===firstCommand.querySelector('summary'),
    text: firstCommand.querySelector('code').textContent
  })`), { same: true, open: true, focused: true, text: 'start + more' });
  console.log('PASS live trace grouping, streaming append, disclosure identity and keyboard focus');
  await evaluate(`host({type:'execution',sessionId:'active',turnId:'t1',response:${JSON.stringify(response)}});
    host({type:'executing',value:false,sessionId:'active',turnId:'t1'});`);
  await settle();
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(processSummary)}).textContent`), /Worked .*1\.2k tokens/, 'completed usage');
  // The prompt is the row body now, so only the process line keeps a title bar.
  assert.equal(await evaluate(`document.querySelector('[data-turn-section="input"]')`), null, 'no Input section');
  assert.ok(await evaluate(`document.querySelector('[data-turn-section="process"] > summary .output-copy') !== null`), 'process copy in the line');
  assert.ok(await evaluate(`document.querySelector('[data-turn-section="output"] > .output-copy') !== null`), 'answer copy over the answer');
  const displayed = await evaluate(`document.querySelector('pre.json-output-text > code').textContent`);
  assert.deepEqual(JSON.parse(displayed), JSON.parse(raw));
  assert.equal(await evaluate(`document.querySelectorAll('.json-output strong,.json-output img').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.json-output').length`), 1);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.markdown-body strong')).some(el=>el.textContent==='still bold')`));
  assert.equal(await evaluate(`new Promise(resolve=>{const deadline=Date.now()+15000;const check=()=>{if(document.querySelector('[data-diagram-state=ready] svg'))resolve(true);else if(Date.now()>deadline)resolve(false);else setTimeout(check,50);};check();})`), true, 'a Mermaid fence in Output renders a diagram');
  assert.equal(await evaluate(`document.querySelector('[data-diagram-state=ready] svg').textContent.includes('完成')`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.markdown-diagram-staging').length`), 0, 'diagram staging DOM is cleaned up');
  assert.ok(await evaluate(`document.getElementById('result').textContent.includes('{invalid JSON}')`));
  await click('.json-output .output-copy');
  assert.equal(await evaluate(`messages.findLast(m=>m.type==='clipboardWrite').text`), raw, 'live copy is byte-for-byte source');
  await click('.json-disclosure > summary');
  assert.equal(await evaluate(`document.querySelector('.json-disclosure').open`), false);
  await click('.json-disclosure > summary');
  assert.equal(await evaluate(`document.querySelector('[data-turn-section=output]').textContent.includes('EncodedCommand')`), false, 'terminal API results stay out of Output');
  const solo = '.agent-stream-panel > .agent-trace-command';
  await click(`${solo} > summary`);
  assert.equal(await evaluate(`document.querySelector('${solo} code').textContent`), command);
  assert.ok((await evaluate(`document.querySelector('${solo} summary').textContent`)).length <= 180);

  const checkWidths = async (selector) => {
    for (const width of [760, 480, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await settle();
      const sizes = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el=>({name:el.className||el.id,width:el.clientWidth,scroll:el.scrollWidth}))`);
      assert.ok(sizes.length > 0);
      assert.ok(sizes.every(s=>s.scroll<=s.width+1), `${width}px overflow: ${JSON.stringify(sizes)}`);
    }
  };
  await checkWidths('#result-body,.json-output,.agent-trace-command');
  console.log('PASS live JSON folding, literal strings, exact copy, full command and 760/480/320px layout');

  // Re-open the persisted workflow through Conversation's actual hydration path.
  await evaluate(`host({type:'outputSession',hostInitiated:true,session:{id:'active',createdAt:1,updatedAt:2,turns:[${JSON.stringify(record)}]}});`);
  await settle();
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(processSummary)}).textContent`), /Worked 4ms · 1\.2k tokens/, 'reopened usage');
  assert.ok(await evaluate(`document.querySelector('[data-turn-section="process"] > summary .output-copy') !== null`), 'reopened process copy');
  assert.ok(await evaluate(`document.querySelector('[data-turn-section="output"] > .output-copy') !== null`), 'reopened answer copy');
  assert.equal(await evaluate(`document.querySelector('.json-output-text').textContent`), displayed);
  await click('.json-output .output-copy');
  assert.equal(await evaluate(`messages.findLast(m=>m.type==='clipboardWrite').text`), raw);

  const planPath = 'plans/build.plan.md';
  const acceptance = { id: 'accept-abc', text: '**Review** the output', checked: false };
  const permission = {
    sessionId: 'active', turnId: 'latest-plan', requestId: 'permission', status: 'submitted', action: 'confirm', answers: {},
    form: { title: 'Allow tool?', description: '**Write plan**', presentation: 'dialog', show_cancel: true, cancel_label: 'Deny',
      actions: [{ id: 'confirm', label: 'Allow once', primary: true, requires: [] }], fields: [] }
  };
  const plan = { ...record, id: 'latest-plan', mode: 'plan', executePlan: true, planPath,
    planOutcome: { status: 'completed', reason: 'fixture', rounds: 1 }, process: [
      { phase: 'todo', text: '', todos: [{ id: 'plan-1', status: 'completed', text: 'Implement' }] },
      { phase: 'input', text: '', uiInteraction: permission }
    ] };
  const planSession = { id: 'active', createdAt: 1, updatedAt: 3,
    turns: [{ ...plan, id: 'older-plan' }, plan], planProgress: { path: planPath, acceptance: [acceptance] } };
  await evaluate(`host({type:'outputSession',hostInitiated:true,session:${JSON.stringify(planSession)}})`);
  await settle();
  const check = '[data-turn-id="latest-plan"] input[data-acceptance-id]';
  await evaluate(`window.acceptanceBefore = document.querySelector(${JSON.stringify(check)});`);
  await click('[data-turn-id="latest-plan"] label[for="acceptance-accept-abc"]');
  assert.deepEqual(await evaluate(`messages.filter(m=>m.type==='togglePlanAcceptance')`), [
    { type: 'togglePlanAcceptance', planPath, itemId: acceptance.id, checked: true }
  ]);
  await evaluate(`host({type:'planAcceptance',sessionId:'unrelated',planPath:${JSON.stringify(planPath)},items:[${JSON.stringify(acceptance)}]})`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(check)})===acceptanceBefore`), true);
  await evaluate(`host({type:'planAcceptance',sessionId:'active',planPath:${JSON.stringify(planPath)},items:[${JSON.stringify({ ...acceptance, checked: true })}]})`);
  assert.deepEqual(await evaluate(`(() => {
    const box=document.querySelector(${JSON.stringify(check)});
    return { changed:box!==acceptanceBefore, checked:box.checked, focused:document.activeElement===box,
      rows:document.querySelectorAll('input[data-acceptance-id]').length,
      progress:box.closest('.agent-acceptance').querySelector('.turn-section-meta').textContent };
  })()`), { changed: true, checked: true, focused: true, rows: 1, progress: '1/1 accepted' });
  const staticPlan = renderHistoryRecord(plan, 'active', [{ ...acceptance, checked: true }]);
  assert.deepEqual(await evaluate(`(() => {
    const historyDocument=document.implementation.createHTMLDocument();
    historyDocument.body.innerHTML=${JSON.stringify(staticPlan)};
    const box=historyDocument.querySelector('input[data-acceptance-id]');
    return { checked:box.checked, disabled:box.disabled, label:box.labels[0]?.textContent.trim() };
  })()`), { checked: true, disabled: true, label: 'Review the output' });
  assert.deepEqual(await evaluate(`(() => {
    const historyDocument=document.implementation.createHTMLDocument();
    historyDocument.body.innerHTML=${JSON.stringify(staticPlan)};
    const snapshot=(root)=>{
      const task=root.querySelector('.agent-todo-item');
      return {status:task.dataset.status,badge:task.querySelector('.agent-todo-status').outerHTML,
        tag:task.tagName, list:task.parentElement.tagName};
    };
    return [snapshot(document.querySelector('[data-turn-id="latest-plan"]')),snapshot(historyDocument)];
  })()`), Array.from({ length: 2 }, () => ({
    status: 'completed', badge: '<span class="agent-todo-status">Completed</span>', tag: 'LI', list: 'UL'
  })));
  assert.deepEqual(await evaluate(`(() => {
    const historyDocument=document.implementation.createHTMLDocument();
    historyDocument.body.innerHTML=${JSON.stringify(staticPlan)};
    const snapshot=(root)=>{
      const card=root.querySelector('.agent-input-disclosure');
      return {tag:card.tagName,title:card.querySelector('summary strong').textContent,
        body:card.querySelector('.agent-input-disclosure-body strong').textContent,
        interactive:Boolean(card.closest('.agent-input-card').querySelector('dialog,form'))};
    };
    return [snapshot(document.querySelector('[data-turn-id="latest-plan"]')),snapshot(historyDocument)];
  })()`), Array.from({ length: 2 }, () => ({
    tag: 'DETAILS', title: 'Allow tool? — Submitted (Allow once)', body: 'Write plan', interactive: false
  })));
  console.log('PASS live acceptance delegation, host confirmation, focus and disabled History checkbox');

  const viewOne = execution({ kind: 'view', nodes: [
    { type: 'Stack', children: [
      { type: 'Section', title: 'Summary', children: [
        { type: 'Inline', children: [{ type: 'Text', text: 'src/view.ts' }, { type: 'Badge', text: 'Warning', tone: 'warning' }] },
        { type: 'Markdown', source: '**Display first** [link](https://example.com/path) `src/view.ts`\n\n```mermaid\ngraph TD; A-->B\n```' }
      ] },
      { type: 'Section', title: 'Details', children: [{ type: 'CodeBlock', code: 'src/view.ts' }] },
      { type: 'Section', title: 'Notes', children: [{ type: 'Alert', text: 'Review the file', tone: 'info' }] }
    ] }
  ] });
  const viewTwo = execution({ kind: 'view', nodes: [{ type: 'Text', text: 'Display second' }] });
  const ordinary = execution({ kind: 'ask', text: 'Ordinary answer `src/view.ts`' });
  const viewResponse = { kind: 'workflow', executions: [viewOne, viewTwo, ordinary], steps: [
    { method: 'ui.render', state: 'success', response: viewOne },
    { method: 'stdout', state: 'success', stream: { channel: 'stdout', text: 'between displays' } },
    { method: 'ui.render', state: 'success', response: viewTwo },
    { method: 'ask', state: 'success', response: ordinary }
  ] };
  await evaluate(`host({type:'executing',value:true,sessionId:'active',turnId:'display-view',source:'ui.render()',mode:'code',startedAt:Date.now()});`);
  for (let redraw = 0; redraw < 2; redraw++) {
    await evaluate(`host({type:'execution',sessionId:'active',turnId:'display-view',response:${JSON.stringify(viewResponse)}})`);
    await settle();
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-turn-id=display-view] .turn-output-body > .execution-result')].map(row=>({
      text:(row.querySelector('strong')??row.querySelector('.process-output,[data-script-view],p'))?.textContent.trim(),
      tree:row.querySelectorAll('[data-script-view]').length,
      copies:[...row.querySelectorAll('[data-script-view] button')].map(button=>button.disabled),
      links:row.querySelectorAll('[data-script-view] a,[data-script-view] img').length
    }))`), [
      { text: 'Display first', tree: 1, copies: [true], links: 0 },
      { text: 'between displays', tree: 0, copies: [], links: 0 },
      { text: 'Display second', tree: 1, copies: [], links: 0 },
      { text: 'Ordinary answer src/view.ts', tree: 0, copies: [], links: 0 }
    ]);
  }
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-turn-id=display-view] [data-ui=section] > h3')].map(node=>node.textContent)`),
    ['Summary', 'Details', 'Notes']);
  assert.equal(await evaluate(`document.querySelector('[data-turn-id=display-view] [data-script-view] .output-copyable > pre > code').textContent`), 'src/view.ts');
  await evaluate(`host({type:'executing',value:false,sessionId:'active',turnId:'display-view',
    changes:[{path:'src/view.ts',reason:'fixture change'}]});`);
  assert.deepEqual(await evaluate(`(() => {
    const turn = document.querySelector('[data-turn-id=display-view]');
    return {
      scriptLinks: turn.querySelectorAll('[data-script-view] a').length,
      answerLinks: [...turn.querySelectorAll('.output-turn-change-link')].map(link=>link.textContent),
      changes: turn.querySelector('.output-turn-change-path code')?.textContent
    };
  })()`), { scriptLinks: 0, answerLinks: ['src/view.ts'], changes: 'src/view.ts' });
  console.log('PASS two read-only displays stay ordered and their code stays inert after Changes arrive');

  const partialView = { ...viewResponse, executions: [viewOne, viewTwo], steps: [viewResponse.steps[0], viewResponse.steps[2]] };
  const interruptedTurns = [
    { ...record, id: 'failed-view', output: '', response: partialView, error: 'Script failed.' },
    { ...record, id: 'cancelled-view', output: '', response: partialView, error: 'Execution was cancelled.' }
  ];
  const interruptedOutput = id => `[...document.querySelectorAll('[data-turn-id="${id}"] .turn-output-body > :is(.execution-result,.error-output)')]
    .map(row=>(row.querySelector('[data-script-view] strong') ?? row).textContent.trim())`;
  const expectedOutput = turn => ['Display first', 'Display second', turn.error];
  for (const turn of interruptedTurns) {
    const id = JSON.stringify(turn.id);
    await evaluate(`host({type:'executing',value:true,sessionId:'active',turnId:${id},source:'ui.render()',mode:'code',startedAt:Date.now()});`);
    if (turn.id === 'cancelled-view') {
      await click('#run');
      assert.deepEqual(await evaluate(`messages.findLast(message=>message.type==='stopExecution')`), { type: 'stopExecution', turnId: turn.id });
    }
    await evaluate(`host({type:'executionFailed',sessionId:'active',turnId:${id},message:${JSON.stringify(turn.error)},response:${JSON.stringify(partialView)}});
      host({type:'executing',value:false,sessionId:'active',turnId:${id}});`);
    assert.deepEqual(await evaluate(interruptedOutput(turn.id)), expectedOutput(turn));
  }
  await evaluate(`host({type:'outputSession',hostInitiated:true,session:{id:'active',createdAt:1,updatedAt:2,turns:${JSON.stringify(interruptedTurns)}}});`);
  await evaluate(`document.querySelectorAll('details[data-turn-id]').forEach(turn=>turn.open=true)`);
  await settle();
  for (const turn of interruptedTurns) assert.deepEqual(await evaluate(interruptedOutput(turn.id)), expectedOutput(turn));
  console.log('PASS failed and stopped turns keep their outputs in order during execution and when reopened');

  // History's HTML adapter and the shipped delegated copy handler.
  const historyProvider = await readFile('src/features/conversations/host/historyEditorProvider.ts', 'utf8');
  const historyScriptStart = historyProvider.indexOf('<script nonce="${nonce}">') + '<script nonce="${nonce}">'.length;
  const historyScript = historyProvider.slice(historyScriptStart, historyProvider.indexOf('</script>', historyScriptStart));
  await evaluate(`document.body.innerHTML='<section class="history-view"><div class="history-content" id="history-fixture"></div></section>';`);
  await evaluate(`(()=>{${historyScript}})()`);
  for (const saved of [record, { ...record, output: raw }]) {
    const html = renderHistoryRecord(JSON.parse(JSON.stringify(saved)));
    await evaluate(`document.getElementById('history-fixture').innerHTML=${JSON.stringify(html)};
      document.querySelectorAll('details').forEach(el=>el.open=true);`);
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(processSummary)}).textContent`), /1\.2k tokens/, 'History usage including records without duration');
    assert.ok(await evaluate(`document.querySelector('[data-turn-section="process"] > summary [data-copy]') !== null`), 'history process copy');
    assert.ok(await evaluate(`document.querySelector('[data-turn-section="output"] > [data-copy]') !== null`), 'history answer copy');
    assert.equal(await evaluate(`document.querySelector('pre.json-output-text > code').textContent`), displayed);
    await click('.json-output [data-copy]');
    assert.equal(await evaluate(`messages.findLast(m=>m.type==='copy').text`), raw, 'history HTML parsing preserves CRLF copy payload');
    assert.equal(await evaluate(`document.querySelector('.process-command-solo pre > code').textContent`), command);
    await checkWidths('.history-content,.json-output,.process-command-solo');
  }
  console.log('PASS Conversation re-open and History replay including legacy raw JSON, exact CRLF copy and narrow layout');

  const savedView = { ...record, id: 'saved-view', output: JSON.stringify(viewResponse), changedFiles: ['src/view.ts'] };
  await evaluate(`document.getElementById('history-fixture').innerHTML=${JSON.stringify(renderHistoryRecord(savedView, 's1'))};
    window.dextRenderDiagrams(document.getElementById('history-fixture'));`);
  assert.deepEqual(await evaluate(`({
    trees:document.querySelectorAll('[data-script-view]').length,
    inert:document.querySelectorAll('[data-script-view] a,[data-script-view] img,[data-script-view] .markdown-diagram').length,
    disabled:document.querySelector('[data-script-view] button').disabled,
    path:document.querySelector('[data-script-view] code').textContent
  })`), { trees: 2, inert: 0, disabled: true, path: 'src/view.ts' });

  // A lazily loaded History session arrives as HTML; the provider's inline script
  // must hand it to the shared diagram renderer.
  await evaluate(`document.body.insertAdjacentHTML('beforeend','<details class="history-session" data-history-session-id="s1"><summary>x</summary><div class="history-session-body" id="history-diagram-body"></div></details>');
    window.dispatchEvent(new MessageEvent('message',{data:{type:'historySessionBody',sessionId:'s1',html:${JSON.stringify(renderHistoryRecord(JSON.parse(JSON.stringify(record))))}}}));`);
  assert.equal(await evaluate(`new Promise(resolve=>{const deadline=Date.now()+15000;const check=()=>{if(document.querySelector('#history-diagram-body [data-diagram-state=ready] svg'))resolve(true);else if(Date.now()>deadline)resolve(false);else setTimeout(check,50);};check();})`), true, 'History renders a Mermaid fence in a lazily loaded session');
});
