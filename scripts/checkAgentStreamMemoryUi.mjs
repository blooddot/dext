import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

// Production host stream -> production browser, including Process copy/replay.
// Usage between every chunk reproduces the Pi pattern that defeated adjacency.
const bundle = await build({ entryPoints: ['src/features/conversations/host/agentEventStream.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' });
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { AgentEventStream } = module.exports;
const messages = [], log = [];
const stream = new AgentEventStream({ activeSessionId: () => 'active', disposed: () => false,
  post: message => messages.push(message), schedule: () => 0, cancelSchedule: () => {} });
let prose = '', tool = '';
for (let index = 0; index < 1500; index++) {
  prose += '思考中。'; tool += `输出 ${index}\n`;
  stream.append('active', log, { phase: 'reasoning', id: 'r', text: prose, replace: true });
  stream.append('active', log, { phase: 'tool', id: 't', title: 'Run', text: tool, replace: true });
  stream.append('active', log, { phase: 'status', text: '', usage: { outputTokens: index } });
  stream.flush();
}
const wireCharacters = messages.reduce((sum, message) => sum + message.event.text.length, 0);
assert.equal(log.length, 3);
assert.equal(wireCharacters, prose.length + tool.length);

await runLabChecks(async ({ evaluate, settle, click }) => {
  const template = await readFile('src/app/sidebarProvider.ts', 'utf8');
  const body = template.slice(template.indexOf('<body>') + 6, template.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  await evaluate(`lab.production.destroy();document.querySelectorAll('link[rel="stylesheet"],style').forEach(el=>el.remove());
    document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.messages=[]; window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));
    window.acquireVsCodeApi=()=>({postMessage:m=>{messages.push(m);if(m.type==='clipboardWrite')queueMicrotask(()=>host({type:'clipboardWriteResult',requestId:m.requestId,success:true}));},getState:()=>({}),setState:()=>{}});`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/webview/main.css', 'utf8'))};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  await evaluate(`window.selection={profileId:'pi',mode:'agent',permission:'full-access',model:'test',reasoningEffort:'',speed:'',serviceTier:''};
    host({type:'state',state:{methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[{id:'pi',provider:'pi',label:'Pi',command:'pi',models:['test']}],agentSelection:selection}});
    host({type:'conversations',sessions:[{id:'active',title:'Stream',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'active',selection,planStatus:'new',hostInitiated:true});
    host({type:'executing',value:true,sessionId:'active',turnId:'turn',source:'stream stress',mode:'agent',startedAt:Date.now()});
    for(const message of ${JSON.stringify(messages)})host(message);`);
  await settle();
  const verify = async () => {
    assert.equal(await evaluate(`document.querySelectorAll('.agent-trace-message').length`), 1);
    assert.equal(await evaluate(`document.querySelectorAll('.agent-trace-command').length`), 1);
    assert.equal(await evaluate(`document.querySelector('.agent-trace-command-body').textContent`), tool);
    await click('[data-turn-section="process"] > summary .output-copy');
    assert.equal(await evaluate(`messages.findLast(m=>m.type==='clipboardWrite').text`), `${prose}\n\n${tool}`);
  };
  await verify();
  await evaluate(`host({type:'executing',value:false,sessionId:'active',turnId:'turn'});
    host({type:'outputSession',hostInitiated:true,session:{id:'active',createdAt:1,updatedAt:2,turns:[{id:'turn',createdAt:1,input:'stream stress',mode:'agent',output:'',process:${JSON.stringify(log)}}]}});`);
  await settle();
  await verify();
  console.log(`PASS 4,500 interleaved events: ${log.length} retained rows, ${wireCharacters} wire text characters; live and reopened Process copy exact`);
}, false);
