import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

await runLabChecks(async ({ evaluate, settle, send, artifacts }) => {
  const key = async (key, code) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code });
  };
  const template = await readFile('src/app/sidebarProvider.ts', 'utf8');
  const body = template.slice(template.indexOf('<body>') + 6, template.lastIndexOf('</body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  await evaluate(`lab.production.destroy();document.querySelectorAll('link[rel="stylesheet"],style').forEach(el=>el.remove());
    document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.acquireVsCodeApi=()=>({postMessage:()=>{},getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/webview/main.css', 'utf8'))};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  await evaluate(`window.selection={profileId:'codex',mode:'plan',permission:'full-access',model:'test-model',reasoningEffort:'',speed:'',serviceTier:''};
    host({type:'state',state:{methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[{id:'codex',provider:'codex',label:'Codex CLI',command:'codex',models:['test-model']}],agentSelection:selection,skills:[{id:'ponytail',title:'Ponytail',description:'Lean code',packId:'ponytail',packName:'Ponytail',commandIds:['ponytail-review']},{id:'ponytail-review',title:'Review',description:'Review',packId:'ponytail',packName:'Ponytail',commandIds:[]}],skillCommands:[{id:'ponytail-review',title:'Review',description:'Review',skillId:'ponytail',packId:'ponytail',packName:'Ponytail',syntax:'/ponytail-review'}],skillsEnabled:true}});
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
  assert.equal(await evaluate(`document.getElementById('skills-menu-shell').hidden`), false, 'Skills is a primary composer control');
  await evaluate(`document.getElementById('skills-control').click()`);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#skills-menu .composer-skill-option')).map(button=>[button.getAttribute('aria-checked'),button.textContent])`), [
    ['unchecked', 'Ponytail2 skills'],
    ['unchecked', 'Ponytail/ponytail-review'],
    ['unchecked', 'Review']
  ]);
  await evaluate(`document.querySelector('#skills-menu .composer-skill-pack').focus()`);
  await key("ArrowDown", 40);
  assert.equal(await evaluate(`document.activeElement?.textContent`), "Ponytail/ponytail-review", 'roving focus reaches a skill row');
  await key("ArrowDown", 40);
  assert.equal(await evaluate(`document.activeElement?.textContent`), "Review");
  await key("Escape", 27);
  assert.equal(await evaluate(`document.getElementById('skills-menu').hidden`), true);
  // The host resolves variants for the active Agent; Input keeps one logical
  // selection and updates its version label and availability on a state change.
  await evaluate(`window.routedSkillsState={methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],
    agentProfiles:[{id:'codex',provider:'codex',label:'Codex CLI',command:'codex',models:['test-model']},{id:'claude',provider:'claude',label:'Claude CLI',command:'claude',models:[]}],
    agentSelection:{...selection,skills:['ponytail']},skillsEnabled:true,skillCommands:[],skills:[
      {id:'ponytail',title:'Ponytail',description:'Lean code',packId:'ponytail',packName:'Ponytail',commandIds:[],variant:'codex',available:true},
      {id:'claude-only',title:'Claude only',description:'Claude version',packId:'ponytail',packName:'Ponytail',commandIds:[],available:false}]};
    host({type:'state',state:routedSkillsState});document.getElementById('skills-control').click();`);
  assert.match(await evaluate(`document.querySelector('[data-value="skill:ponytail"]').textContent`), /Codex version/);
  assert.equal(await evaluate(`document.querySelector('[data-value="skill:claude-only"]').disabled`), true);
  await evaluate(`routedSkillsState.agentSelection={...routedSkillsState.agentSelection,profileId:'claude'};
    routedSkillsState.skills[0].variant='shared';routedSkillsState.skills[1]={...routedSkillsState.skills[1],variant:'claude',available:true};
    host({type:'state',state:routedSkillsState});`);
  assert.match(await evaluate(`document.querySelector('[data-value="skill:ponytail"]').textContent`), /Shared version/);
  assert.equal(await evaluate(`document.querySelectorAll('[data-value="skill:ponytail"]').length`), 1);
  assert.equal(await evaluate(`document.querySelector('[data-value="skill:ponytail"]').getAttribute('aria-checked')`), 'checked');
  assert.equal(await evaluate(`document.querySelector('[data-value="skill:claude-only"]').disabled`), false);
  await key("Escape", 27);
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
      if (width === 320) {
        assert.equal(await evaluate(`getComputedStyle(document.querySelector('.composer-skills .composer-control-label')).display`), "none", "320 collapses the Skills label");
      }
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 940, height: 1000, deviceScaleFactor: 1, mobile: false });
  await settle();
  const shot = await send('Page.captureScreenshot');
  await writeFile(join(artifacts, 'plan-attachment-layout.png'), Buffer.from(shot.data, 'base64'));
  await evaluate(`document.querySelector('.image-attachment-remove').click()`);
  await settle();
  assert.equal((await bounds()).input.top, before.input.top, 'removing final attachment restores Input height');
  await evaluate(`host({type:'planContext',path:'a.plan.md',status:'active',projectContext:{workspaceKey:'test',planPath:'a.plan.md',documentHash:'h',fileHash:'f',availability:'ready',assessment:'change',reason:'Interface changed',basis:[],reviewStatus:'pending'}})`);
  assert.match(await evaluate(`document.querySelector('#plan-status').textContent`), /Project update required/);
  await evaluate(`host({type:'planContext',status:'new'})`);
  console.log('PASS Plan attachments, layout, and Project status state');
}, false);
