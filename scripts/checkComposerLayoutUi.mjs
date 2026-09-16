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
    host({type:'conversations',sessions:[{id:'active',title:'Layout',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'active',selection,planStatus:'new',hostInitiated:true});`);
  const bounds = () => evaluate(`{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
    ({input:rect('#input-section'),editor:rect('#code-editor'),attachments:rect('#attachment-bar'),actions:rect('.action-row'),body:rect('#input-body'),viewport:innerHeight,
      overflow:document.documentElement.scrollHeight>innerHeight,
      sendVisible:(()=>{const el=document.getElementById('run'),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.bottom-2));})()})
  }`);
  const fits = (box, label) => {
    assert.ok(Math.abs(box.input.bottom - box.viewport) <= 1, `${label}: Input bottom aligns with viewport`);
    assert.ok(box.actions.bottom <= box.body.bottom + 1, `${label}: footer is not clipped: ${JSON.stringify(box)}`);
    assert.ok(box.attachments.bottom <= box.actions.top + 1, `${label}: attachments stay above footer`);
    assert.ok(box.editor.bottom <= box.attachments.top + 1, `${label}: editor stays above attachments`);
    assert.ok(box.sendVisible, `${label}: Send remains clickable at its bottom edge`);
    assert.equal(box.overflow, false, `${label}: no page overflow`);
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 940, height: 1000, deviceScaleFactor: 1, mobile: false });
  await settle();
  const before = await bounds();
  await evaluate(`host({type:'imageAttachment',relativePath:'.dext-global/attachments/layout.png',name:'layout.png',webviewUri:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="skyblue"/></svg>'});`);
  await settle();
  const after = await bounds();
  fits(after, 'Plan with image');
  assert.ok(after.input.top < before.input.top - 40, 'attachment expands Input upward');
  assert.equal(after.editor.height, before.editor.height, 'sufficient space preserves editor height');
  for (const width of [940, 320]) {
    for (const height of [1000, 600, 480, 360, 280]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await settle();
      fits(await bounds(), `${width}x${height}`);
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 940, height: 1000, deviceScaleFactor: 1, mobile: false });
  await settle();
  const shot = await send('Page.captureScreenshot');
  await writeFile(join(artifacts, 'plan-attachment-layout.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('.image-attachment-remove').click()`);
  await settle();
  assert.equal((await bounds()).input.top, before.input.top, 'removing final attachment restores Input height');
  console.log('PASS Plan attachments grow upward, footer alignment, short/narrow viewports, removal');
}, false);
