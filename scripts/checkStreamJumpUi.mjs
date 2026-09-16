import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

await runLabChecks(async ({ evaluate, settle, send, artifacts }) => {
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
    host({type:'conversations',sessions:[{id:'active',title:'Jump',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'active',selection,planStatus:'new',hostInitiated:true});`);
  await settle();

  // A long answer, so #result-body owns a real vertical scrollbar.
  await evaluate(`document.getElementById('result').innerHTML='<div style="height:1400px">tall output</div>'`);
  await settle();

  // The host paints webview scrollbars itself, and the width it picks is what
  // used to decide whether the floating control landed on the track.
  const box = () => evaluate(`{
    const rect=selector=>document.querySelector(selector).getBoundingClientRect();
    const body=document.getElementById('result-body');
    const section=document.getElementById('result-section');
    const button=document.querySelector('.stream-jump-latest');
    if(button.hidden){button.hidden=false}
    const bar=body.offsetWidth-body.clientWidth;
    const bodyRect=rect('#result-body');
    const buttonRect=button.getBoundingClientRect();
    const trackLeft=bodyRect.right-bar;
    const hitAt=(x,y)=>{const el=document.elementFromPoint(x,y);return el?(el.className||el.tagName):null;};
    ({bar,bodyRight:bodyRect.right,bodyBottom:bodyRect.bottom,buttonLeft:buttonRect.left,buttonRight:buttonRect.right,buttonBottom:buttonRect.bottom,
      sectionBottom:section.getBoundingClientRect().bottom,trackLeft,
      hitTrackBottom:hitAt(trackLeft+bar/2,bodyRect.bottom-3),
      hitThumbRest:hitAt(trackLeft+bar/2,bodyRect.bottom-24),
      gutter:getComputedStyle(section).getPropertyValue('--dext-result-scroll-gutter').trim(),
      sectionRight:section.getBoundingClientRect().right})
  }`);

  const check = async (label) => {
    await settle();
    const geometry = await box();
    assert.equal(geometry.hitTrackBottom, 'collapsible-body result-body', `${label}: the end of the track stays clickable (${JSON.stringify(geometry)})`);
    assert.equal(geometry.hitThumbRest, 'collapsible-body result-body', `${label}: the thumb can rest at the track end`);
    assert.ok(geometry.buttonRight <= geometry.trackLeft, `${label}: the control clears the scrollbar track: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.buttonRight < geometry.bodyRight, `${label}: the control stays left of the scrollbar`);
    assert.ok(geometry.buttonBottom <= geometry.sectionBottom, `${label}: the control stays inside the result section`);
    assert.equal(geometry.gutter, `${Math.round(geometry.sectionRight - geometry.trackLeft)}px`.replace(/(\.\d+)?px$/, 'px'), `${label}: published gutter is measured, got ${geometry.gutter}`);
    return geometry;
  };

  for (const width of [10, 14, 20, 26]) {
    await evaluate(`(()=>{document.getElementById('jump-gutter')?.remove();const style=document.createElement('style');style.id='jump-gutter';
      style.textContent='#result-body::-webkit-scrollbar{width:${width}px}';document.head.append(style)})()`);
    const geometry = await check(`${width}px scrollbar`);
    assert.equal(geometry.bar, width, `${width}px scrollbar: the host width is in effect, got ${geometry.bar}`);
    console.log(`PASS ${width}px scrollbar clears the jump-to-latest control`);
  }

  const shot = await send('Page.captureScreenshot');
  await writeFile(join(artifacts, 'stream-jump-scrollbar.png'), Buffer.from(shot.data, 'base64'));
  console.log('PASS jump-to-latest control never covers the conversation scrollbar');
}, false);
