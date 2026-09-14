import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

// Load the production sidebar and final CSS bundle: source-only CSS assertions
// cannot catch a later Monaco codicon rule overriding an idle indicator.
await runLabChecks(async ({ evaluate, settle }) => {
  const template = await readFile('src/sidebarProvider.ts', 'utf8');
  const body = template.slice(template.indexOf('<body>') + 6, template.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  await evaluate(`lab.production.destroy();document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  const css = await readFile('dist/webview/main.css', 'utf8');
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  await evaluate(`window.selection={profileId:'codex',mode:'agent',permission:'full-access',model:'test-model',reasoningEffort:'',speed:'',serviceTier:''};
    host({type:'state',state:{methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[{id:'codex',provider:'codex',label:'Codex CLI',command:'codex',models:['test-model']}],agentSelection:selection}});
    window.tabs=running=>host({type:'conversations',sessions:[
      {id:'active',title:'Active conversation',updatedAt:1,turnCount:0,pinned:false,running},
      {id:'pinned',title:'Pinned idle',updatedAt:1,turnCount:0,pinned:true,running:false}
    ],activeId:'active',selection,planStatus:'new',hostInitiated:true});`);
  const states = () => evaluate(`Array.from(document.querySelectorAll('.conversation-tab'),tab=>({
    running:tab.classList.contains('running'),
    spinner:getComputedStyle(tab.querySelector('.conversation-tab-activity')).display!=='none',
    action:getComputedStyle(tab.querySelector('.conversation-tab-close,.conversation-tab-pin')).display!=='none',
    disabled:tab.querySelector('button:last-child').disabled
  }))`);
  const idle = { running:false, spinner:false, action:true, disabled:false };
  await evaluate('tabs(false)');await settle();
  assert.deepEqual(await states(), [idle,idle], 'restored idle tabs hide activity indicators');
  await evaluate('tabs(true)');await settle();
  assert.deepEqual(await states(), [{ running:true,spinner:true,action:false,disabled:true },idle], 'only the executing conversation shows an activity indicator');
  await evaluate('tabs(false)');await settle();
  assert.deepEqual(await states(), [idle,idle], 'completion hides the indicator and restores tab actions');
  console.log('PASS production tab indicators: restored idle, executing, completed and pinned');
}, false);
