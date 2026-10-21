import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

// Run after npm run build. Production Conversation bundle and History renderer,
// with a mocked VS Code message bridge; this is not a VS Code host acceptance test.
const historyBundle = await build({ entryPoints: ['src/features/conversations/presentation/historyRender.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const historyModule = { exports: {} };
new Function('require', 'module', 'exports', historyBundle.outputFiles[0].text)(createRequire(import.meta.url), historyModule, historyModule.exports);
const { renderHistoryRecord } = historyModule.exports;
const raw = ' \r\n' + JSON.stringify({ 中文: '第一行\n"引号" C:\\path **bold** `code` <img src=x>', nested: [{ long: 'x'.repeat(8000) }] }) + '\r\n ';
const command = 'powershell -NoProfile -EncodedCommand ' + Buffer.from('Write-Output "中文"', 'utf16le').toString('base64').repeat(500);
const execution = (result) => ({ invocation: { kind: 'invocation', method: result.kind, source: 'code', arguments: [] },
  method: { id: result.kind, title: result.kind, kind: 'command', source: 'builtin' }, result, durationMs: 1 });
const response = { kind: 'workflow', executions: [execution({ kind: 'ask', text: raw }), execution({ kind: 'terminal', command,
  cwd: 'C:\\' + 'long-path'.repeat(200), stdout: 'ok', stderr: '', status: 'succeeded', exit_code: 0, duration_ms: 1 }),
  execution({ kind: 'ask', text: '# Ordinary Markdown\n\n**still bold**' }),
  execution({ kind: 'ask', text: '{invalid JSON}' })] };
const usageEvents = [{ phase: 'status', text: '', usage: { totalTokens: 900 } },
  { phase: 'status', text: '', usage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 234 } }];
const record = { id: 't1', createdAt: 1, input: 'structured output', mode: 'code', process: usageEvents, output: JSON.stringify(response) };

await runLabChecks(async ({ evaluate, settle, send, click }) => {
  const template = await readFile('src/sidebarProvider.ts', 'utf8');
  const body = template.slice(template.indexOf('<body>') + 6, template.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  await evaluate(`lab.production.destroy();document.querySelectorAll('link[rel="stylesheet"],style').forEach(el=>el.remove());
    document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.messages=[];
    window.acquireVsCodeApi=()=>({postMessage:m=>{messages.push(m);if(m.type==='clipboardWrite')queueMicrotask(()=>host({type:'clipboardWriteResult',requestId:m.requestId,success:true}));},getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
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
  await evaluate(`host({type:'execution',sessionId:'active',turnId:'t1',response:${JSON.stringify(response)}});
    host({type:'executing',value:false,sessionId:'active',turnId:'t1'});`);
  await settle();
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(processSummary)}).textContent`), /Worked for .*1\.2k tokens/, 'completed usage');
  const displayed = await evaluate(`document.querySelector('.json-output-text').textContent`);
  assert.deepEqual(JSON.parse(displayed), JSON.parse(raw));
  assert.equal(await evaluate(`document.querySelectorAll('.json-output strong,.json-output img').length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.json-output').length`), 1);
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.markdown-body strong')).some(el=>el.textContent==='still bold')`));
  assert.ok(await evaluate(`document.getElementById('result').textContent.includes('{invalid JSON}')`));
  await click('.json-output .output-copy');
  assert.equal(await evaluate(`messages.findLast(m=>m.type==='clipboardWrite').text`), raw, 'live copy is byte-for-byte source');
  await click('.json-disclosure > summary');
  assert.equal(await evaluate(`document.querySelector('.json-disclosure').open`), false);
  await click('.json-disclosure > summary');
  await click('.terminal-disclosure > summary');
  assert.equal(await evaluate(`document.querySelector('.terminal-command').textContent`), command);
  assert.ok((await evaluate(`document.querySelector('.terminal-command-summary').textContent`)).length < 200);

  const checkWidths = async (selector) => {
    for (const width of [760, 480, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await settle();
      const sizes = await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el=>({name:el.className||el.id,width:el.clientWidth,scroll:el.scrollWidth}))`);
      assert.ok(sizes.length > 0);
      assert.ok(sizes.every(s=>s.scroll<=s.width+1), `${width}px overflow: ${JSON.stringify(sizes)}`);
    }
  };
  await checkWidths('#result-body,.json-output,.terminal-disclosure');
  console.log('PASS live JSON folding, literal strings, exact copy, full command and 760/480/320px layout');

  // Re-open the persisted workflow through Conversation's actual hydration path.
  await evaluate(`host({type:'outputSession',hostInitiated:true,session:{id:'active',createdAt:1,updatedAt:2,turns:[${JSON.stringify(record)}]}});`);
  await settle();
  assert.match(await evaluate(`document.querySelector(${JSON.stringify(processSummary)}).textContent`), /Worked for 4ms · 1\.2k tokens/, 'reopened usage');
  assert.equal(await evaluate(`document.querySelector('.json-output-text').textContent`), displayed);
  await click('.json-output .output-copy');
  assert.equal(await evaluate(`messages.findLast(m=>m.type==='clipboardWrite').text`), raw);

  // History's HTML adapter and the shipped delegated copy handler.
  const historyProvider = await readFile('src/features/conversations/host/historyEditorProvider.ts', 'utf8');
  const historyScript = historyProvider.slice(historyProvider.indexOf('<script nonce="${nonce}">') + '<script nonce="${nonce}">'.length, historyProvider.indexOf('</script>'));
  await evaluate(`document.body.innerHTML='<section class="history-view"><div class="history-content" id="history-fixture"></div></section>';`);
  await evaluate(`(()=>{${historyScript}})()`);
  for (const saved of [record, { ...record, output: raw }]) {
    const html = renderHistoryRecord(JSON.parse(JSON.stringify(saved)));
    await evaluate(`document.getElementById('history-fixture').innerHTML=${JSON.stringify(html)};
      document.querySelectorAll('details').forEach(el=>el.open=true);`);
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(processSummary)}).textContent`), /1\.2k tokens/, 'History usage including records without duration');
    assert.equal(await evaluate(`document.querySelector('.json-output-text').textContent`), displayed);
    await click('.json-output [data-copy]');
    assert.equal(await evaluate(`messages.findLast(m=>m.type==='copy').text`), raw, 'history HTML parsing preserves CRLF copy payload');
    await checkWidths('.history-content,.json-output,.terminal-disclosure');
  }
  console.log('PASS Conversation re-open and History replay including legacy raw JSON, exact CRLF copy and narrow layout');
}, false);
