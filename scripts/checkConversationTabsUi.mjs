import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runWebviewChecks } from './monaco-ref-lab/check.mjs';
import { readSidebarBody } from './monaco-ref-lab/serve.mjs';

// Load the production sidebar and final CSS bundle: source-only CSS assertions
// cannot catch a later Monaco codicon rule overriding an idle indicator.
await runWebviewChecks(async ({ evaluate, settle, send, click, key }) => {
  const body = await readSidebarBody();
  await evaluate(`document.body.innerHTML=${JSON.stringify(body)};
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}
    window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>({}),setState:()=>{}});
    window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  const css = `${await readFile('dist/webview/main.css', 'utf8')}\n${await readFile('media/appearance.css', 'utf8')}`;
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);}`);
  await evaluate(await readFile('dist/webview/main.js', 'utf8'));
  await evaluate(`window.selection={profileId:'codex',mode:'agent',permission:'full-access',model:'test-model',reasoningEffort:'',speed:'',serviceTier:'',skillLoading:'every-turn'};
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
  for (const width of [320, 1460]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    const bounds = await evaluate(`(() => {
      const edges = selector => {
        const { left, right } = document.querySelector(selector).getBoundingClientRect();
        return [left, right];
      };
      return { band: edges('.dext-topbar'), tabs: edges('#conversation-tabs'), content: edges('.app-shell') };
    })()`);
    const gutter = Math.max(0, (width - 1200) / 2);
    assert.deepEqual(bounds, { band: [0, width], tabs: [gutter, width - gutter], content: [gutter, width - gutter] });
    const rail = await evaluate(`(() => {
      const tabs = document.querySelector('#conversation-tabs');
      const row = tabs.querySelector('.conversation-tab-row');
      if (!row) return null;
      const lastTab = row.lastElementChild.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return [getComputedStyle(tabs.parentElement).backgroundColor, bounds.left, bounds.height,
        bounds.right - lastTab.right, style.borderBottomLeftRadius, style.borderBottomRightRadius];
    })()`);
    assert.deepEqual(rail, ['rgba(0, 0, 0, 0)', gutter, 32, 0, '0px', '6px'], 'the background rounds only the inactive outer edge');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(await states(), [idle,idle], 'restored idle tabs hide activity indicators');
  const selectionState = () => evaluate(`[...document.querySelectorAll('#conversation-tabs [role=tab]')].map(tab=>[
    tab.parentElement.dataset.sessionId,tab.getAttribute('aria-selected'),tab.parentElement.classList.contains('active')
  ])`);
  assert.deepEqual(await evaluate(`document.querySelector('#conversation-tabs').getAttribute('role')`), 'tablist');
  assert.deepEqual(await selectionState(), [['active','true',true], ['pinned','false',false]]);
  const tabIds = () => evaluate(`Object.fromEntries([...document.querySelectorAll('#conversation-tabs [role=tab]')]
    .map(tab=>[tab.parentElement.dataset.sessionId, tab.id]))`);
  const initialIds = await tabIds();
  assert.ok(initialIds.active && initialIds.pinned && initialIds.active !== initialIds.pinned);
  const assertPanel = async (sessionId) => {
    assert.deepEqual(await evaluate(`(() => {
      const tabs = [...document.querySelectorAll('#conversation-tabs [role=tab]')];
      const selected = tabs.find(tab=>tab.getAttribute('aria-selected')==='true');
      const panel = document.getElementById(selected.getAttribute('aria-controls'));
      return [selected.parentElement.dataset.sessionId, panel.id, panel.getAttribute('role'),
        document.getElementById(panel.getAttribute('aria-labelledby'))===selected,
        tabs.every(tab=>tab.getAttribute('aria-controls')===panel.id)];
    })()`), [sessionId, 'result-section', 'tabpanel', true, true]);
  };
  await assertPanel('active');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#conversation-tabs [role=tab]')].map(tab=>[
    tab.textContent,tab.parentElement.querySelector('button:last-child').getAttribute('aria-label')
  ])`), [['Active conversation','Close Active conversation'],['Pinned idle','Unpin Pinned idle']]);
  await evaluate('tabs(true)');await settle();
  assert.deepEqual(await tabIds(), initialIds, 'tab IDs survive rerendering');
  assert.deepEqual(await states(), [{ running:true,spinner:true,action:false,disabled:true },idle], 'only the executing conversation shows an activity indicator');
  await evaluate(`document.querySelector('.conversation-tab-close').click()`);
  assert.equal(await evaluate(`sent.filter(m=>m.type==='closeConversation').length`), 0);
  await evaluate('tabs(false)');await settle();
  assert.deepEqual(await states(), [idle,idle], 'completion hides the indicator and restores tab actions');
  await evaluate(`document.querySelector('.conversation-tab-pin').focus()`);await key('Enter', 13);
  await click('.conversation-tab-close');
  assert.deepEqual(await evaluate(`sent.filter(m=>m.type==='pinConversation'||m.type==='closeConversation')`), [
    { type: 'pinConversation', sessionId: 'pinned', pinned: false }, { type: 'closeConversation', sessionId: 'active' }
  ]);
  // Composer drafts follow their tab. Switching, a host-initiated switch and a
  // brand-new conversation must each show that tab's own text.
  const input = () => evaluate(`document.querySelector('#code-editor .view-lines').textContent`);
  await evaluate(`document.querySelector('#code-editor textarea').focus()`);
  await send('Input.insertText', { text: 'draftA' });await settle();
  assert.equal(await input(), 'draftA', 'typing updates the active tab draft');
  await evaluate(`document.querySelector('.conversation-tab[data-session-id="pinned"] .conversation-tab-label').focus()`);
  await key('Enter', 13);
  assert.deepEqual(await selectionState(), [['active','false',false], ['pinned','true',true]]);
  await assertPanel('pinned');
  assert.equal(await evaluate(`document.activeElement.matches('#code-editor textarea')`), true, 'restoring the selected draft focuses the composer');
  assert.equal(await input(), '', 'a tab without a draft opens empty');
  // Leave the switch unanswered so the menu still renders the previous tab's controls.
  await send('Emulation.setDeviceMetricsOverride', { width: 460, height: 600, deviceScaleFactor: 1, mobile: false });
  await settle();
  await evaluate(`document.querySelector('#skills-control').click()`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#skills-menu > [role=menuitemradio]')].map(row=>{
    const label=row.querySelector('span');
    const bounds=label.getBoundingClientRect();
    return [label.textContent,row.getAttribute('aria-checked'),label.scrollWidth<=label.clientWidth&&bounds.right<=innerWidth];
  })`), [['Lazy','false',true],['Always','true',true]], 'loading labels fit a narrow Skills menu');
  assert.match(await evaluate(`document.querySelector('[data-value="loading:on-demand"]').title`), /default for new conversations/);
  await evaluate(`document.querySelector('[data-value="loading:on-demand"]').click();
    document.querySelector('[data-value="loading:every-turn"]').click();`);
  assert.deepEqual(await evaluate(`sent.filter(m=>m.type==='agentSelection'||m.type==='conversationSkillLoading')`), [
    { type: 'conversationSkillLoading', sessionId: 'pinned', skillLoading: 'on-demand' },
    { type: 'conversationSkillLoading', sessionId: 'pinned', skillLoading: 'every-turn' }
  ], 'the loading choices target the highlighted tab and carry no stale Agent controls');
  await key('Escape', 27);
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
  await settle();
  await evaluate(`document.querySelector('#code-editor textarea').focus()`);
  await send('Input.insertText', { text: 'draftB' });await settle();
  await click('.conversation-tab[data-session-id="active"] .conversation-tab-label');
  await assertPanel('active');
  assert.equal(await input(), 'draftA', 'switching back restores the first draft');
  await evaluate(`host({type:'activeConversation',activeId:'pinned',selection,planStatus:'new',hostInitiated:true})`);await settle();
  assert.deepEqual(await selectionState(), [['active','false',false], ['pinned','true',true]]);
  await assertPanel('pinned');
  assert.equal(await input(), 'draftB', 'a host-initiated switch restores the target draft');
  await evaluate(`host({type:'activeConversation',activeId:'fresh',selection,planStatus:'new',hostInitiated:true});
    host({type:'conversations',sessions:[{id:'active',title:'Active conversation',updatedAt:1,turnCount:0,pinned:false,running:false},
      {id:'pinned',title:'Pinned idle',updatedAt:1,turnCount:0,pinned:true,running:false},
      {id:'fresh',title:'New conversation',updatedAt:1,turnCount:0,pinned:false,running:false}],activeId:'fresh',selection,planStatus:'new',hostInitiated:true})`);await settle();
  assert.equal(await input(), '', 'a new tab starts empty instead of inheriting the previous draft');
  await assertPanel('fresh');
  const dividers = () => evaluate(`[...document.querySelectorAll('.conversation-tab')]
    .map(tab=>getComputedStyle(tab,'::before').width==='1px')`);
  assert.deepEqual(await dividers(), [false,true,false], 'dividers only separate adjacent inactive tabs');
  await click('.conversation-tab[data-session-id="pinned"] .conversation-tab-label');
  assert.equal(await input(), 'draftB', 'the older tab still owns its draft');
  assert.deepEqual(await dividers(), [false,false,false], 'the divider disappears when either tab becomes active');
  const order = () => evaluate(`[...document.querySelectorAll('.conversation-tab')].map(tab=>tab.dataset.sessionId)`);
  const point = (id, fraction) => evaluate(`(() => {
    const rect=document.querySelector('[data-session-id="${id}"] .conversation-tab-label').getBoundingClientRect();
    return {x:rect.left+rect.width*${fraction},y:rect.top+rect.height/2};
  })()`);
  const drag = async (cancel) => {
    const from = await point('fresh', 0.5);
    const to = await point('active', 0.25);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, button: 'left', buttons: 1 });
    await settle();
    assert.equal(await evaluate(`document.querySelector('[data-session-id=active]').classList.contains('drop-before')`), true);
    if (cancel) await key('Escape', 27);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
    await settle();
    assert.equal(await evaluate(`document.querySelector('.dragging-tabs,.drop-before,.drop-after')===null`), true);
  };
  const originalOrder = await order();
  await drag(true);
  assert.deepEqual(await order(), originalOrder);
  assert.equal(await evaluate(`sent.some(m=>m.type==='moveConversation')`), false);
  await drag(false);
  assert.equal((await order()).indexOf('fresh') < (await order()).indexOf('active'), true);
  assert.deepEqual(await evaluate(`sent.filter(m=>m.type==='moveConversation')`), [
    { type: 'moveConversation', sessionId: 'fresh', beforeSessionId: 'active' }
  ]);
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`host({type:'conversations', sessions:Array.from({length:8}, (_,i)=>({
    id:'tab-'+i,title:'Conversation '+i,updatedAt:1,turnCount:0,pinned:false,running:false
  })), activeId:'tab-7', selection, planStatus:'new', hostInitiated:true});`);
  assert.ok(await evaluate(`(() => {
    const tabs = document.querySelector('#conversation-tabs');
    return tabs.scrollLeft > 0 && tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft <= 1;
  })()`), 'the last active tab scrolls all the way into view');
  assert.deepEqual(await evaluate(`(() => {
    const row = document.querySelector('.conversation-tab-row');
    const active = row.lastElementChild;
    return [row.getBoundingClientRect().right - active.getBoundingClientRect().right,
      getComputedStyle(row).borderBottomRightRadius, getComputedStyle(active).borderBottomRightRadius,
      getComputedStyle(active,'::after').backgroundImage];
  })()`), [0,'6px','6px','none'], 'an active last tab and its background end in the same rounded corner');
  assert.ok(await evaluate(`(() => {
    const tabs = document.querySelector('#conversation-tabs');
    tabs.scrollLeft = 0;
    tabs.scrollLeft = tabs.scrollWidth;
    return tabs.scrollLeft > 0 && getComputedStyle(tabs).overflowX === 'auto';
  })()`), 'long tab lists scroll inside the band');
  await evaluate(`host({type:'conversations',sessions:[{id:'tab-0',title:'Conversation 0',updatedAt:1,turnCount:0,pinned:false,running:false}],
    activeId:'tab-0',selection,planStatus:'new',hostInitiated:true})`);
  assert.ok(await evaluate(`(() => {
    const tabs = document.querySelector('#conversation-tabs');
    const row = tabs.querySelector('.conversation-tab-row');
    return row.childElementCount === 1 && row.offsetWidth < tabs.clientWidth
      && getComputedStyle(row).borderBottomLeftRadius === '0px'
      && row.offsetWidth === row.firstElementChild.offsetWidth;
  })()`), 'a single active tab ends flush with the row');
  await evaluate(`{
    const tabs = document.querySelector('#conversation-tabs');
    const {right, top} = tabs.getBoundingClientRect();
    document.elementFromPoint(right-1, top+16).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));
  }`);
  assert.equal(await evaluate(`sent.filter(m=>m.type==='newConversation').length`), 1);
  await evaluate(`host({type:'conversations',sessions:[],activeId:'',selection,planStatus:'new',hostInitiated:true})`);
  assert.equal(await evaluate(`document.querySelector('#conversation-tabs').getBoundingClientRect().width`), 0);
  assert.equal(await evaluate(`document.getElementById('result-section').hasAttribute('aria-labelledby')`), false);
  console.log('PASS rounded tab background, aligned and scrollable tabs, roles, focus, running state, close/pin, drafts and dragging');
});
