import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

const historyBundle = await build({ entryPoints: ['src/features/conversations/presentation/historyRender.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const historyModule = { exports: {} };
new Function('require', 'module', 'exports', historyBundle.outputFiles[0].text)(createRequire(import.meta.url), historyModule, historyModule.exports);
const { renderHistoryRecord } = historyModule.exports;

const patch = { kind: 'patch', title: 'Legacy', changes: [{ uri: 'file:///a.ts', before: 'old', after: 'new' }] };
const execution = (patchApplication, legacy = false) => ({
  invocation: { kind: 'invocation', method: 'agent', source: 'code', arguments: [] },
  method: { id: 'agent', title: 'Agent', kind: 'command', source: 'builtin' },
  result: { kind: 'agent', text: 'Agent finished.', ...(legacy ? { patch } : {}) },
  durationMs: 1, ...(patchApplication ? { patchApplication } : {})
});
const workflow = (entry) => ({ kind: 'workflow', executions: [entry] });
const record = (entry) => ({ id: 'patch', createdAt: 1, input: 'edit', process: [], output: '', response: workflow(entry) });

await runLabChecks(async ({ evaluate, settle }) => {
  const template = await readFile('src/app/sidebarProvider.ts', 'utf8');
  const body = template.slice(template.indexOf('<body>') + 6, template.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  await evaluate(`lab.production.destroy();document.querySelectorAll('link[rel="stylesheet"],style').forEach(el=>el.remove());
    document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.errors=[];window.addEventListener('error',e=>errors.push(e.error?.stack??e.message));
    window.messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>messages.push(m),getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/webview/main.css', 'utf8'))};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  await evaluate(`window.selection={profileId:'codex',permission:'full-access',model:'test-model',reasoningEffort:'',speed:'',serviceTier:''};
    host({type:'state',state:{methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[],agentSelection:selection}});
    host({type:'conversations',sessions:[{id:'active',title:'Patch',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'active',selection,planStatus:'new',hostInitiated:true});`);
  const absent = async () => {
    assert.equal(await evaluate(`document.querySelectorAll('.patch-review-actions,.agent-file-change,[data-review-uri],[data-review-all],[data-diff-mode],.diff-view').length`), 0);
    assert.equal(await evaluate(`messages.some(m=>m.type==='resolvePatch')`), false);
  };
  for (const status of ['applied', 'conflict', 'unchanged']) {
    const summary = status === 'conflict' ? 'a.ts changed after the patch was created.' : 'The patch contains no changes.';
    const entry = execution({ kind: 'apply', status, files: status === 'applied' ? [{ uri: 'a.ts' }, { uri: 'b.ts' }, { uri: 'c.ts' }] : [], summary });
    await evaluate(`host({type:'executing',value:true,sessionId:'active',turnId:'patch',source:'edit',mode:'code',startedAt:Date.now()});
      host({type:'agentEvents',sessionId:'active',events:[{phase:'message',text:${JSON.stringify(JSON.stringify({ kind: 'agent', text: 'Streamed answer', patch }))}}]});`);
    await settle();
    await absent();
    await evaluate(`host({type:'execution',sessionId:'active',turnId:'patch',response:${JSON.stringify(workflow(entry))}});
      host({type:'executing',value:false,sessionId:'active',turnId:'patch'});`);
    await settle();
    await absent();
    assert.equal(await evaluate(`document.querySelector('.patch-application')!==null`), true,
      JSON.stringify(await evaluate(`({errors, messages, output:document.getElementById('result').innerHTML.slice(-3000)})`)));
    const text = await evaluate(`document.querySelector('.patch-application').textContent`);
    assert.equal(text, status === 'applied' ? 'Automatically applied changes to 3 files.' : `Auto-apply ${status}: ${summary}`);
    assert.equal(await evaluate(`document.querySelector('.patch-application').getAttribute('role')`), status === 'conflict' ? 'alert' : 'status');
    // Both Conversation hydration and the standalone History renderer retain outcomes.
    await evaluate(`host({type:'outputSession',hostInitiated:true,session:{id:'active',createdAt:1,updatedAt:2,turns:[${JSON.stringify(record(entry))}]}});`);
    await settle();
    assert.equal(await evaluate(`document.querySelector('.patch-application').textContent`), text);
    await absent();
    assert.ok(renderHistoryRecord(record(entry)).includes(text));
  }
  await evaluate(`host({type:'outputSession',hostInitiated:true,session:{id:'active',createdAt:1,updatedAt:3,turns:[${JSON.stringify(record(execution(undefined, true)))}]}});`);
  await settle();
  assert.match(await evaluate(`document.querySelector('.patch-application').textContent`), /Legacy patch ignored/);
  await absent();
  assert.match(renderHistoryRecord(record(execution(undefined, true))), /Legacy patch ignored/);
  console.log('PASS patch outcomes, real errors, legacy ignore, history hydration and no review UI');
}, false);
