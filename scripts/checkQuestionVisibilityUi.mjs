import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

// A question parks the turn, so it has to reach the reader. The card renders
// above the Process timeline, and a live turn grows that timeline far past the
// viewport while the reader follows the newest output - which left a published
// question thousands of pixels off screen and the turn waiting for an answer
// nobody could see. This check drives the real Webview bundle: the question
// must be revealed, the follow must be released so the next batch cannot push
// it back out, and a question the agent answers in parallel must not move the
// reader at all.
await runLabChecks(async ({ evaluate, settle }) => {
  const template = await readFile('src/sidebarProvider.ts', 'utf8');
  const body = template.slice(template.indexOf('<body>') + 6, template.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  await evaluate(`lab.production.destroy();document.querySelectorAll('link[rel="stylesheet"],style').forEach(el=>el.remove());
    document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.acquireVsCodeApi=()=>({postMessage:()=>{},getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/webview/main.css', 'utf8'))};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  const question = {
    id: "dext-question-1", blocking: true, status: "waiting", questions: [{
      id: "test", header: "test 目录", question: "本次 test/ 测试目录生成到什么程度？", options: [
        { label: "只生成 test/README.md 占位说明（推荐）", description: "目录与约定先立起来。" },
        { label: "按任务生成 TC 用例骨架 md", description: "现在就从验收标准派生 TC-<功能>-NN-*.md。" },
        { label: "本次不建 test 目录", description: "只做 task/ 拆分。" }
      ]
    }]
  };
  await evaluate(`window.selection={profileId:'deepseek-harness',mode:'agent',permission:'full-access',model:'m',reasoningEffort:'',speed:'',serviceTier:''};
    host({type:'state',state:{methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[{id:'deepseek-harness',provider:'deepseek-harness',label:'Harness',command:'dsh',models:['m']}],agentSelection:selection}});
    host({type:'conversations',sessions:[{id:'active',title:'Question',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'active',selection,planStatus:'new',hostInitiated:true});
    window.row=(n)=>'Row '+n+': the streamed answer keeps growing while the reader follows it. '+'x'.repeat(120);
    window.stream=(count)=>{const events=[];for(let n=1;n<=count;n++){
      events.push({phase:'reasoning',id:'r'+n,text:window.row(n)});
      events.push({phase:'tool',id:'c'+n,toolKind:'command',title:'pwsh',text:window.row(n)});
      events.push({phase:'message',id:'m'+n,text:'Let me ask. '+window.row(n),group:'work-log'});}
      host({type:'agentEvents',sessionId:'active',events});};
    window.ask=(userInput)=>host({type:'agentEvent',sessionId:'active',event:{phase:'input',text:'',userInput}});
    window.form=(uiInteraction)=>host({type:'agentEvent',sessionId:'active',event:{phase:'input',text:'',uiInteraction}});
    window.box=()=>{const b=document.getElementById('result-body');const cards=[...document.querySelectorAll('.agent-input-card')];const card=cards.at(-1);const view=b.getBoundingClientRect();
      const r=card?card.getBoundingClientRect():null;
      return {scrollTop:Math.round(b.scrollTop),max:Math.round(b.scrollHeight-b.clientHeight),
        gap:Math.round(b.scrollHeight-b.scrollTop-b.clientHeight),
        cards:cards.length,forms:document.querySelectorAll('.agent-input-card form').length,
        jumpHidden:document.querySelector('.stream-jump-latest').hidden,
        visible:Boolean(r)&&r.bottom>view.top&&r.top<view.bottom,
        fullyVisible:Boolean(r)&&r.top>=view.top&&r.bottom<=view.bottom,
        panel:r?Math.round(r.top-view.top):null,view:Math.round(view.height)};};`);
  await settle();
  await evaluate(`host({type:'executing',value:true,sessionId:'active',turnId:'t1',source:'Long turn',startedAt:Date.now()})`);
  await settle();
  await evaluate('stream(60)');
  await settle();
  await settle();
  const following = await evaluate('box()');
  assert.equal(following.gap, 0, `the reader follows the long live turn, got ${JSON.stringify(following)}`);
  assert.ok(following.max > following.view, `the turn is longer than the viewport, got ${JSON.stringify(following)}`);

  await evaluate(`ask(${JSON.stringify(question)})`);
  await settle();
  await settle();
  let current = await evaluate('box()');
  assert.equal(current.cards, 1, `the published question renders a card, got ${JSON.stringify(current)}`);
  assert.equal(current.forms, 1, `the card is answerable, got ${JSON.stringify(current)}`);
  assert.equal(current.visible, true, `the question is brought into view, got ${JSON.stringify(current)}`);
  assert.equal(current.fullyVisible, true, `the whole form fits the conversation viewport, got ${JSON.stringify(current)}`);
  assert.equal(current.jumpHidden, false, `revealing the question releases the follow, got ${JSON.stringify(current)}`);
  console.log('PASS a blocking question in a long live turn is revealed and the follow is released');

  // The turn is parked on the question: later output must not sweep the card
  // back out of the viewport the moment it is visible.
  await evaluate('stream(61)');
  await settle();
  await settle();
  current = await evaluate('box()');
  assert.equal(current.visible, true, `the card stays in view while the turn is parked, got ${JSON.stringify(current)}`);
  console.log('PASS the parked question stays in view');

  // A reader who moved away keeps their position: only a state that newly puts
  // a card on screen may move the view.
  await evaluate(`{const b=document.getElementById('result-body');b.scrollTop=0;}`);
  await settle();
  const parked = await evaluate('box()');
  await evaluate(`ask(${JSON.stringify(question)})`);
  await settle();
  await settle();
  current = await evaluate('box()');
  assert.equal(current.scrollTop, parked.scrollTop, `a repeated waiting state does not reclaim the view, got ${JSON.stringify({ parked, current })}`);
  console.log('PASS a repeated waiting state leaves the reader where they moved');

  await evaluate(`ask(${JSON.stringify({ ...question, id: 'dext-question-2', status: 'dismissed' })})`);
  await settle();

  // A question the agent keeps working through does not park the turn, so it
  // must not pull the reader out of the stream.
  await evaluate(`{const b=document.getElementById('result-body');b.scrollTop=b.scrollHeight-b.clientHeight;}`);
  await settle();
  await evaluate(`ask(${JSON.stringify({ ...question, id: 'dext-question-3', blocking: false })})`);
  await settle();
  await settle();
  current = await evaluate('box()');
  assert.equal(current.visible, false, `a parallel question does not move the reader, got ${JSON.stringify(current)}`);
  assert.equal(current.jumpHidden, true, `a parallel question keeps the follow, got ${JSON.stringify(current)}`);
  console.log('PASS a question the agent answers in parallel does not move the reader');

  // API forms park a workflow the same way, and land in the same card area.
  await evaluate(`form({sessionId:'active',turnId:'t1',requestId:'call',status:'waiting',form:{title:'Confirm',presentation:'inline',show_cancel:true,cancel_label:'Cancel',
    actions:[{id:'submit',label:'Continue',primary:true,requires:[]}],fields:[{id:'note',type:'input',label:'Note',required:false}]}})`);
  await settle();
  await settle();
  current = await evaluate('box()');
  assert.equal(current.visible, true, `a waiting API form is revealed too, got ${JSON.stringify(current)}`);
  console.log('PASS a waiting API form is revealed');
}, false);
