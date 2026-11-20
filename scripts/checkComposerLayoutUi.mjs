import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWebviewChecks } from './monaco-ref-lab/check.mjs';
import { readSidebarBody } from './monaco-ref-lab/serve.mjs';

await runWebviewChecks(async ({ evaluate, settle, send, key, artifacts }) => {
  const body = await readSidebarBody();
  await evaluate(`document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/webview/main.css', 'utf8'))};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  await evaluate(`window.selection={profileId:'codex',mode:'plan',permission:'full-access',model:'test-model',reasoningEffort:'',speed:'',serviceTier:''};
    host({type:'state',state:{methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[{id:'codex',provider:'codex',label:'Codex CLI',command:'codex',models:['test-model']}],agentSelection:selection,skills:[{id:'ponytail',title:'Ponytail',description:'Lean code',packId:'ponytail',packName:'Ponytail',commandIds:['ponytail-review']},{id:'ponytail-review',title:'Review',description:'Review',packId:'ponytail',packName:'Ponytail',commandIds:[]}],skillCommands:[{id:'ponytail-review',title:'Review',description:'Review',skillId:'ponytail',packId:'ponytail',packName:'Ponytail',syntax:'/ponytail-review'}],skillsEnabled:true}});
    host({type:'conversations',sessions:[{id:'active',title:'Layout',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'active',selection,planStatus:'new',hostInitiated:true});`);
  const bounds = () => evaluate(`{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};};
    ({input:rect('#input-section'),editor:rect('#code-editor'),attachments:rect('#attachment-bar'),actions:rect('.action-row'),body:rect('#input-body'),shellBottom:rect('.app-shell').bottom,
      overflow:document.documentElement.scrollHeight>document.documentElement.clientHeight,
      triggersFit:(()=>{const send=document.getElementById('run').getBoundingClientRect().left;
        const rects=[...document.querySelectorAll('#composer-controls > .composer-menu > .composer-control, #composer-controls > .composer-more')]
          .filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect()).sort((a,b)=>a.left-b.left);
        return rects.every((rect,index)=>rect.right<=send&&(!index||rect.left>=rects[index-1].right));})(),
      sendVisible:(()=>{const el=document.getElementById('run'),r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+r.width/2,r.bottom-2));})()})
  }`);
  const fits = (box, label) => {
    assert.ok(box.triggersFit, `${label}: composer triggers stay apart, left of Send`);
    assert.ok(Math.abs(box.input.bottom - box.shellBottom) <= 1, `${label}: Input bottom aligns with the app shell: ${JSON.stringify(box)}`);
    assert.ok(box.actions.bottom <= box.body.bottom + 1, `${label}: footer is not clipped: ${JSON.stringify(box)}`);
    assert.ok(box.attachments.bottom <= box.actions.top + 1, `${label}: attachments stay above footer`);
    assert.ok(box.attachments.bottom <= box.editor.top + 1, `${label}: attachments stay above the editor`);
    assert.ok(box.sendVisible, `${label}: Send remains clickable at its bottom edge`);
    assert.equal(box.overflow, false, `${label}: no page overflow`);
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 940, height: 1000, deviceScaleFactor: 1, mobile: false });
  await settle();
  const before = await bounds();
  assert.equal(await evaluate(`document.getElementById('skills-menu-shell').hidden`), false, 'Skills is a primary composer control');
  await evaluate(`document.getElementById('skills-control').click()`);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#skills-menu .composer-skill-option')).map(button=>[button.getAttribute('aria-checked'),button.textContent])`), [
    ['false', 'Ponytail2 skills'],
    ['false', 'Ponytail/ponytail-review'],
    ['false', 'Review']
  ]);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#skills-menu > button')].map(row=>[
    row.getAttribute('role'),row.dataset.level,row.querySelector('small')?.textContent??null
  ])`), [['menuitemcheckbox','0','2 skills'],['menuitemcheckbox','1','/ponytail-review'],['menuitemcheckbox','1',null]]);
  await evaluate(`document.querySelector('#skills-menu .composer-skill-pack').focus()`);
  await key("ArrowDown", 40);
  assert.equal(await evaluate(`document.activeElement?.textContent`), "Ponytail/ponytail-review", 'roving focus reaches a skill row');
  await key("ArrowDown", 40);
  assert.equal(await evaluate(`document.activeElement?.textContent`), "Review");
  await key("Escape", 27);
  assert.equal(await evaluate(`document.getElementById('skills-menu').hidden`), true);
  assert.equal(await evaluate(`document.activeElement.id`), 'skills-control');
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
  assert.equal(await evaluate(`document.activeElement.dataset.value`), "pack:ponytail", "skills initially focus the first enabled row");
  await key("End", 35);
  assert.equal(await evaluate(`document.activeElement.dataset.value`), "skill:ponytail", "End skips the disabled skill");
  await evaluate(`routedSkillsState.agentSelection={...routedSkillsState.agentSelection,profileId:'claude'};
    routedSkillsState.skills[0].variant='shared';routedSkillsState.skills[1]={...routedSkillsState.skills[1],variant:'claude',available:true};
    host({type:'state',state:routedSkillsState});`);
  assert.match(await evaluate(`document.querySelector('[data-value="skill:ponytail"]').textContent`), /Shared version/);
  assert.equal(await evaluate(`document.querySelectorAll('[data-value="skill:ponytail"]').length`), 1);
  assert.equal(await evaluate(`document.querySelector('[data-value="skill:ponytail"]').getAttribute('aria-checked')`), 'true');
  assert.equal(await evaluate(`document.querySelector('[data-value="skill:claude-only"]').disabled`), false);
  await key("Escape", 27);
  await evaluate(`host({type:'imageAttachment',relativePath:'.dext-global/attachments/layout.png',name:'layout.png',webviewUri:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="skyblue"/></svg>'});`);
  await settle();
  const after = await bounds();
  fits(after, 'Plan with image');
  assert.ok(after.input.height > before.input.height + 40, 'attachment expands Input upward');
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
  assert.equal((await bounds()).input.height, before.input.height, 'removing final attachment restores Input height');
  await evaluate(`host({type:'planContext',status:'new'})`);
  // Annotating the same picture again must edit the block the tab already wrote
  // instead of stacking a second copy, in this session and after a restart.
  const block = (note) => `Image annotations for @.dext-global/attachments/shot.png (pixel coordinates, origin top-left):\n1. region (160,160)-(480,400): ${note}`;
  await evaluate(`host({type:'insertAnnotations',text:${JSON.stringify(block('first'))}})`);
  await settle();
  await evaluate(`host({type:'insertAnnotations',text:${JSON.stringify(block('second'))},previous:${JSON.stringify(block('first'))}})`);
  await settle();
  const copyInput = async () => {
    await evaluate(`document.querySelector('#code-editor .monaco-editor textarea')?.focus()`);
    for (const [key, code] of [['a', 65], ['c', 67]]) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, modifiers: 2 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers: 2 });
    }
    await settle();
    return evaluate(`navigator.clipboard.readText()`);
  };
  const annotated = await copyInput();
  assert.equal(annotated.split("Image annotations for @").length - 1, 1, `re-inserting edits the block in place: ${annotated}`);
  assert.match(annotated, /: second$/m);
  console.log('PASS re-annotating replaces the block in Input');
  // The composer collapses to its toolbar row so the output can own the height.
  const expandedHeight = (await bounds()).input.height;
  await evaluate(`document.getElementById('composer-collapse').click()`);
  await settle();
  assert.deepEqual(await evaluate(`(() => {
    const panel=document.getElementById('input-shell');
    return {height:panel.getBoundingClientRect().height,overflow:getComputedStyle(panel).overflow};
  })()`), { height: 0, overflow: 'hidden' }, 'collapsed composer clips the editor away');
  assert.equal(await evaluate(`document.getElementById('composer-collapse').getAttribute('aria-expanded')`), 'false');
  const collapsed = await bounds();
  assert.ok(collapsed.input.height < expandedHeight - 40, `collapsed composer returns the editor height to the output: ${expandedHeight} -> ${collapsed.input.height}`);
  assert.ok(collapsed.actions.bottom <= collapsed.body.bottom + 1, `collapsed footer stays inside the input body: ${JSON.stringify(collapsed)}`);
  assert.ok(collapsed.sendVisible, 'Send stays clickable while collapsed');
  const collapsedShot = await send('Page.captureScreenshot');
  await writeFile(join(artifacts, 'collapsed-composer.png'), Buffer.from(collapsedShot.data, 'base64'));
  await evaluate(`document.getElementById('composer-collapse').click()`);
  await settle();
  assert.equal(Math.round((await bounds()).input.height), Math.round(expandedHeight), 'expanding restores the input height');
  assert.equal(await evaluate(`Boolean(document.activeElement?.closest('#code-editor'))`), true, 'expanding focuses the editor');
  console.log('PASS Collapsing the composer gives the editor height back to the output');
  console.log('PASS Plan attachments and layout state');

  await evaluate(`window.menuState={...routedSkillsState,skills:[],agentSelection:selection,agentProfiles:[
    {id:'codex',provider:'codex',label:'Codex CLI',command:'codex',models:['test-model','other-model'],
      modelOptions:[
        {id:'test-model',label:'Current model',group:'Primary',reasoningEfforts:['low'],speedTiers:[],serviceTiers:[]},
        {id:'other-model',label:'Other model',group:'Secondary',reasoningEfforts:[],speedTiers:[],serviceTiers:[]}
      ]}
  ]};host({type:'state',state:menuState});document.getElementById('skills-control').click();`);
  assert.equal(await evaluate(`document.querySelector('#skills-menu .composer-menu-empty').textContent.startsWith('No skills are installed')`), true);
  // Empty notes are not keyboard options. Close this menu through the trigger.
  assert.equal(await evaluate(`document.querySelectorAll('#skills-menu > button').length`), 0);
  await evaluate(`document.getElementById('skills-control').click();document.getElementById('model-control').click();`);
  await settle();
  assert.equal(await evaluate(`document.activeElement.matches('#model-menu > button.composer-menu-category')`), true);
  await key('ArrowRight', 39);
  assert.equal(await evaluate(`document.activeElement.textContent`), 'Current model');
  assert.deepEqual(await evaluate(`[...document.querySelector('#model-submenu').children].map(child=>[
    child.textContent,child.getAttribute('role'),child.getAttribute('aria-checked')
  ])`), [['Model',null,null],['Primary',null,null],['Current model','menuitemradio','true'],['Secondary',null,null],['Other model','menuitemradio','false']]);
  await key('ArrowLeft', 37);
  assert.equal(await evaluate(`document.getElementById('model-submenu').hidden&&document.activeElement.matches('#model-menu > button:first-child')`), true);
  await key('ArrowRight', 39);
  await key('ArrowDown', 40);
  assert.equal(await evaluate(`document.activeElement.textContent`), 'Other model');
  await key('Enter', 13);
  assert.equal(await evaluate(`sent.findLast(m=>m.type==='agentSelection')?.selection.model`), 'other-model');

  const boxes = () => evaluate(`(() => {
    const rect=selector=>{const {left,right,top,bottom,width,height}=document.querySelector(selector).getBoundingClientRect();return {left,right,top,bottom,width,height};};
    return {viewport:innerWidth,shell:rect('.app-shell'),parent:rect('#model-menu'),sub:rect('#model-submenu'),
      hit:(()=>{const r=rect('#model-submenu');return Boolean(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('#model-submenu'));})()};
  })()`);
  const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= 1, `${message}: ${actual} vs ${expected}`);
  const probeAnchor = process.argv.includes('--probe-anchor');
  const anchorRules = `
    #model-menu { anchor-name: --dext-model-menu; }
    #model-submenu {
      position: fixed;
      position-anchor: --dext-model-menu;
      position-try-fallbacks: --dext-model-left, --dext-model-above;
      inset: auto auto anchor(bottom) calc(anchor(right) + 4px);
      width: min(216px, calc(100% - 24px));
      max-height: 310px;
      margin: 0 8px 0 0;
    }
    @position-try --dext-model-left {
      inset: auto calc(anchor(left) + 4px) anchor(bottom) auto;
      margin: 0 0 0 8px;
    }
    @position-try --dext-model-above {
      inset: 8px auto calc(anchor(top) + 4px) anchor(left);
      align-self: end;
      max-height: stretch;
      margin: 0;
    }`;
  const browserVersion = probeAnchor ? (await send('Browser.getVersion')).product : '';
  const scenarios = [
    ['right', 940, 520, 80], ['left', 1680, 520, 960], ['above', 660, 520, 222],
    ...(probeAnchor ? [['right', 940, 280, 80, true, true]] : []), ['above', 320, 340, 40, true]
  ];
  for (const [side, width, height, offset, longMenu, probeOnly] of scenarios) {
    if (longMenu) await evaluate(`host({type:'state',state:{...menuState,agentProfiles:[{...menuState.agentProfiles[0],
      models:[...menuState.agentProfiles[0].models,...Array.from({length:28},(_,i)=>'Long menu candidate '+i)]
    }]}})`);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const resized = `innerWidth===${width}&&innerHeight===${height}&&document.getElementById('composer-controls').classList.contains('is-compact')===${width === 320}`;
    for (let attempt = 0; attempt < 30 && !(await evaluate(resized)); attempt++) await settle();
    assert.equal(await evaluate(resized), true, side + ' viewport and composer have resized');
    await settle();
    await evaluate(`(() => {
      const menu=document.getElementById('model-menu');
      const controls=document.getElementById('composer-controls');
      menu.parentElement.style.left='';
      const control=document.getElementById('model-control');
      if(controls.classList.contains('is-compact')&&!controls.classList.contains('show-extra'))document.getElementById('composer-more').click();
      control.click();
      const column=menu.closest('.app-shell').getBoundingClientRect();
      menu.parentElement.style.left=(column.left+${offset}-menu.getBoundingClientRect().left)+'px';
    })()`);
    await settle();
    await key('ArrowRight', 39);
    const { viewport, shell, parent, sub, hit } = await boxes();
    near(sub.width, Math.min(216, shell.width - 24), side + ' width');
    if (!probeOnly) assert.ok(sub.left >= shell.left + 7 && sub.right <= shell.right - 7 && sub.top >= shell.top + 7 && hit,
      side + ' submenu fits inside the actual clipping column');
    if (side === 'right') near(sub.left, parent.right + 4, 'right gap');
    if (side === 'left') {
      assert.ok(viewport - parent.right >= 228 && shell.right - parent.right < 228, 'the viewport alone would incorrectly allow a right submenu');
      near(sub.right, parent.left - 4, 'left gap');
    }
    if (side === 'above') {
      near(sub.bottom, parent.top - 4, 'above gap');
      near(sub.left, parent.left, 'above alignment');
    }
    if (longMenu && !probeOnly) {
      assert.equal(await evaluate(`(() => {
        const menu=document.getElementById('model-submenu');
        menu.scrollTop=48;
        return menu.scrollTop>0;
      })()`), true, 'a height-clamped submenu scrolls');
      await send('Emulation.setDeviceMetricsOverride', { width, height: height + 40, deviceScaleFactor: 1, mobile: false });
      for (let attempt = 0; attempt < 30 && await evaluate('innerHeight') !== height + 40; attempt++) await settle();
      await settle();
      const resizedBoxes = await boxes();
      assert.ok(resizedBoxes.sub.height > sub.height && resizedBoxes.sub.top >= resizedBoxes.shell.top + 7,
        `open submenu resizes inside the column: ${JSON.stringify({ before: sub, after: resizedBoxes })}`);
    }
    if (probeAnchor) {
      const baseline = (await boxes()).sub;
      const submenuInline = await evaluate(`document.getElementById('model-submenu').getAttribute('style')`);
      const supported = await evaluate(`CSS.supports('anchor-name: --test')&&CSS.supports('position-try-fallbacks: --test')`);
      await evaluate(`(() => {
        const style=document.createElement('style');
        style.id='anchor-probe';style.textContent=${JSON.stringify(anchorRules)};document.head.append(style);
        const submenu=document.getElementById('model-submenu');
        submenu.style.left='';submenu.style.maxHeight='';
      })()`);
      for (const containment of ['viewport', 'column']) {
        if (containment === 'column') await evaluate(`document.getElementById('anchor-probe').textContent+=' .app-shell { contain: layout; }';`);
        await settle();
        const candidate = await boxes();
        const equivalent = candidate.hit && ['left', 'right', 'top', 'bottom'].every(edge => Math.abs(candidate.sub[edge] - baseline[edge]) <= 1);
        console.log(`CSS anchor ${side}/${width}x${height} ${containment} ${JSON.stringify({ browserVersion, supported, equivalent, baseline, candidate: candidate.sub, hit: candidate.hit })}`);
      }
      await evaluate(`document.getElementById('anchor-probe').remove();document.getElementById('model-submenu').setAttribute('style',${JSON.stringify(submenuInline)});`);
    }
    await key('Escape', 27);
    assert.equal(await evaluate(`document.getElementById('model-menu').hidden&&document.getElementById('model-submenu').hidden&&document.activeElement.id===(
      document.getElementById('composer-controls').classList.contains('is-compact')?'composer-more':'model-control')`), true);
  }
  await evaluate(`document.getElementById('model-menu').parentElement.style.left='';host({type:'state',state:{...menuState,
    agentSelection:{...selection,model:''},agentProfiles:[{...menuState.agentProfiles[0],models:[],modelOptions:[]}]}});document.getElementById('model-control').click();`);
  assert.equal(await evaluate(`document.querySelector('#model-menu .composer-menu-empty').textContent`), 'No models are available for this Agent.');
  console.log('PASS menu structure, disabled and selected items, parent and child focus, and right/left/above clipping geometry');
});
