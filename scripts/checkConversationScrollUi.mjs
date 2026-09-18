import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

// Regression coverage for the conversation scroll port. A streamed batch can
// grow #result-body in the same frame a reader drags its scrollbar, so the
// position has to be re-measured instead of remembering the end from an earlier
// frame, and no scroll event the app did not ask for may cancel that
// correction.
await runLabChecks(async ({ evaluate, settle, send, click, key, artifacts }) => {
  const template = await readFile('src/sidebarProvider.ts', 'utf8');
  const body = template.slice(template.indexOf('<body>') + 6, template.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  await evaluate(`lab.production.destroy();document.querySelectorAll('link[rel="stylesheet"],style').forEach(el=>el.remove());
    document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.acquireVsCodeApi=()=>({postMessage:()=>{},getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/webview/main.css', 'utf8'))};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  await evaluate(`window.selection={profileId:'codex',mode:'plan',permission:'full-access',model:'test-model',reasoningEffort:'',speed:'',serviceTier:''};
    host({type:'state',state:{methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[{id:'codex',provider:'codex',label:'Codex CLI',command:'codex',models:['test-model']}],agentSelection:selection}});
    host({type:'conversations',sessions:[{id:'active',title:'Scroll',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'active',selection,planStatus:'new',hostInitiated:true});
    window.answer=(n)=>Array.from({length:4},(_,i)=>"Row "+n+"."+i+": the streamed answer keeps growing while the reader follows it.").join(" ");
    window.stream=(n)=>host({type:'agentEvents',sessionId:'active',events:[{phase:'reasoning',id:'m1',text:window.answer(n)}]});
    window.tool=(n)=>host({type:'agentEvents',sessionId:'active',events:[{phase:'tool',id:'c'+n,toolKind:'command',title:'pwsh',groupId:'g1',groupLabel:'Ran '+n+' commands',text:window.answer(n)}]});
    window.openTrace=()=>document.querySelectorAll('details.agent-trace-command,details.agent-trace-tool').forEach((d)=>d.open=true);
    window.state=()=>{const b=document.getElementById('result-body');const jump=document.querySelector('.stream-jump-latest');
      return {top:Math.round(b.scrollTop),max:Math.round(b.scrollHeight-b.clientHeight),
        gap:Math.round(b.scrollHeight-b.scrollTop-b.clientHeight),jumpHidden:jump.hidden,
        overflowAnchor:getComputedStyle(b).overflowAnchor};};
    window.track=()=>{const b=document.getElementById('result-body');const r=b.getBoundingClientRect();
      const bar=b.offsetWidth-b.clientWidth;const h=b.clientHeight;const thumb=Math.max(20,h*b.clientHeight/Math.max(1,b.scrollHeight));
      return {x:r.right-bar/2,right:r.right,bottom:r.bottom,bar,h,
        thumbTop:r.top+(h-thumb)*b.scrollTop/Math.max(1,b.scrollHeight-b.clientHeight),thumbHeight:thumb};};`);
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await settle();

  const state = () => evaluate('state()');
  // Keyboard and wheel scrolling is animated, so a single settle can measure a
  // position the host is still moving.
  const settleScroll = async () => {
    let previous = -1;
    for (let attempt = 0; attempt < 20; attempt++) {
      await settle();
      const top = await evaluate(`document.getElementById('result-body').scrollTop`);
      if (top === previous) return;
      previous = top;
    }
  };
  const drag = async (toTrackFraction) => {
    const geometry = await evaluate('track()');
    const grabY = geometry.thumbTop + geometry.thumbHeight / 2;
    const releaseY = geometry.bottom - geometry.h * toTrackFraction;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: grabY, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x, y: releaseY, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x, y: releaseY, button: 'left', clickCount: 1 });
    await settle();
    return geometry;
  };
  const wheel = async (deltaY) => {
    const geometry = await evaluate('track()');
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: geometry.right - 40, y: geometry.bottom - 40, deltaX: 0, deltaY });
    await settle();
    await settle();
  };
  const growBeyondViewport = async (from) => {
    let n = from;
    while (true) {
      await evaluate(`stream(${n})`);
      await settle();
      const current = await state();
      if (current.max > 400) return current;
      n += 1;
    }
  };

  // A live turn that owns a real scrollbar, with the reader following it.
  await evaluate(`host({type:'executing',value:true,sessionId:'active',turnId:'t1',source:'Scroll check',startedAt:Date.now()})`);
  await settle();
  let current = await growBeyondViewport(1);
  for (let n = 20; n <= 24; n++) {
    await evaluate(`stream(${n})`);
    await settle();
    current = await state();
    assert.equal(current.gap, 0, `a following reader stays at the end of a streamed batch, got ${JSON.stringify(current)}`);
    assert.equal(current.jumpHidden, true, `the jump control stays hidden while following, got ${JSON.stringify(current)}`);
  }
  assert.equal(current.overflowAnchor, 'none', 'the scroll port disables browser scroll anchoring');
  console.log('PASS a streamed batch keeps a following reader at the newest output');

  // Command output is the other half of a live turn: its panel caps its own
  // height, so expanding it while the reader follows must still land at the end.
  await evaluate(`tool(25)`);
  await settle();
  await evaluate(`openTrace()`);
  await settle();
  current = await state();
  assert.ok(current.gap <= 24, `expanding command output keeps a following reader at the end, got ${JSON.stringify(current)}`);
  await evaluate(`tool(26)`);
  await settle();
  current = await state();
  assert.equal(current.gap, 0, `command output keeps following, got ${JSON.stringify(current)}`);
  console.log('PASS command panels keep a following reader at the newest output');

  // The reported bug: the batch of the frame the reader is dragging in makes
  // the drag stop short, and the correction that would fix it used to be
  // cancelled by the drag's own scroll event.
  const dragGeometry = await evaluate('track()');
  const grabY = dragGeometry.thumbTop + dragGeometry.thumbHeight / 2;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dragGeometry.x, y: grabY, button: 'left', clickCount: 1 });
  const span = dragGeometry.bottom - 3 - grabY;
  for (let step = 1; step <= 6; step++) {
    const y = grabY + (span * step) / 6;
    await evaluate(`stream(${30 + step})`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dragGeometry.x, y, button: 'left', buttons: 1 });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragGeometry.x, y: dragGeometry.bottom - 3, button: 'left', clickCount: 1 });
  await settle();
  current = await state();
  assert.ok(current.gap <= 24, `a drag released at the track end lands on the live end, got ${JSON.stringify(current)}`);
  assert.equal(current.jumpHidden, true, `a drag released at the track end clears the jump control, got ${JSON.stringify(current)}`);
  await evaluate(`stream(40)`);
  await settle();
  current = await state();
  assert.equal(current.gap, 0, `the batch after that drag still follows, got ${JSON.stringify(current)}`);
  console.log('PASS a scrollbar drag to the track end lands on the live end and keeps following');

  // Reading history must not be undone by the next batch.
  await evaluate(`{const b=document.getElementById('result-body');b.scrollTop=Math.max(0,Math.round(b.scrollHeight/3));}`);
  await settle();
  await evaluate(`stream(41)`);
  await settle();
  const parked = await state();
  assert.ok(parked.gap > 24, `reading earlier output parks the view above the end, got ${JSON.stringify(parked)}`);
  assert.equal(parked.jumpHidden, false, `the jump control appears once the reader scrolls away, got ${JSON.stringify(parked)}`);
  await evaluate(`stream(42)`);
  await settle();
  current = await state();
  assert.equal(current.top, parked.top, `a parked reader is not pulled by later batches, got ${JSON.stringify({ parked, current })}`);
  console.log('PASS earlier output stays put while the stream continues');

  // Wheeling up is a deliberate move into history.
  await wheel(-240);
  const wheeled = await state();
  assert.ok(wheeled.gap > 24, `wheeling up moves away from the end, got ${JSON.stringify(wheeled)}`);
  await evaluate(`stream(43)`);
  await settle();
  current = await state();
  assert.equal(current.top, wheeled.top, `wheeling up survives later batches, got ${JSON.stringify({ wheeled, current })}`);
  console.log('PASS wheeling up releases the follow');

  // The jump control is the way back, and following resumes there.
  await click('.stream-jump-latest');
  current = await state();
  assert.ok(current.gap <= 24, `the jump control reaches the newest output, got ${JSON.stringify(current)}`);
  assert.equal(current.jumpHidden, true, `the jump control hides itself at the end, got ${JSON.stringify(current)}`);
  await evaluate(`stream(44)`);
  await settle();
  current = await state();
  assert.equal(current.gap, 0, `following resumes after the jump control, got ${JSON.stringify(current)}`);
  console.log('PASS the jump control returns to the end and resumes following');

  // A drag that stops in the middle keeps the position the reader chose.
  await drag(0.4);
  const midDrag = await state();
  assert.ok(midDrag.gap > 24, `a mid-track drag parks above the end, got ${JSON.stringify(midDrag)}`);
  await evaluate(`stream(45)`);
  await settle();
  current = await state();
  assert.equal(current.top, midDrag.top, `a mid-track drag is not pulled by later batches, got ${JSON.stringify({ midDrag, current })}`);
  console.log('PASS a mid-track drag keeps the chosen position');

  // Scrolling back to the end by hand resumes following.
  await wheel(1200);
  await wheel(1200);
  const returned = await state();
  assert.ok(returned.gap <= 24, `wheeling down reaches the end again, got ${JSON.stringify(returned)}`);
  await evaluate(`stream(46)`);
  await settle();
  current = await state();
  assert.equal(current.gap, 0, `following resumes after wheeling back to the end, got ${JSON.stringify(current)}`);
  console.log('PASS wheeling back to the end resumes following');

  // The jump control hands the reader a keyboard scroller (#result-body), and
  // the same rules apply to the keys that move it.
  await wheel(-300);
  await click('.stream-jump-latest');
  const afterJump = await state();
  assert.ok(afterJump.gap <= 24, `the jump control focuses the reader at the end, got ${JSON.stringify(afterJump)}`);
  assert.equal(await evaluate(`document.activeElement?.id`), 'result-body',
    'the jump control focuses the conversation scroller so the keyboard can move it');
  await key('PageUp', 33);
  await settleScroll();
  const paged = await state();
  assert.ok(paged.gap > 24, `PageUp moves away from the end, got ${JSON.stringify(paged)}`);
  await evaluate(`stream(47)`);
  await settle();
  current = await state();
  assert.equal(current.top, paged.top, `PageUp survives later batches, got ${JSON.stringify({ paged, current })}`);
  await key('End', 35);
  await settleScroll();
  const ended = await state();
  assert.ok(ended.gap <= 24, `End returns to the newest output, got ${JSON.stringify(ended)}`);
  await evaluate(`stream(48)`);
  await settle();
  current = await state();
  assert.equal(current.gap, 0, `following resumes after End, got ${JSON.stringify(current)}`);
  console.log('PASS the keyboard scroller follows the same rules');

  const shot = await send('Page.captureScreenshot');
  await writeFile(join(artifacts, 'conversation-scroll.png'), Buffer.from(shot.data, 'base64'));
}, false);
