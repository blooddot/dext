import assert from 'node:assert/strict';
import { writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLabChecks } from './monaco-ref-lab/check.mjs';
await runLabChecks(async ({evaluate,key,settle,send,artifacts}) => {
  const source='前 @src/界面/a.ts#L1,1-L3,4 后 @other/a.ts\n@.dext-global/attachments/image.png';
  await evaluate('lab.reset('+JSON.stringify(source)+')');
  const selection=(from,to)=>evaluate('lab.select('+from+','+to+')');
  // Native multi-cursor delete and history restore all reference identities.
  await evaluate('lab.editor.setSelections(lab.refs().map(ref=>lab.monaco.Selection.fromPositions(lab.model.getPositionAt(ref.viewFrom),lab.model.getPositionAt(ref.viewTo))))');
  await key('Backspace',8);assert.equal(await evaluate('lab.source()'),'前  后 \n');await key('z',90,2);assert.equal(await evaluate('lab.source()'),source);
  await key('y',89,2);await key('z',90,2);assert.equal(await evaluate('lab.source()'),source);
  // Copy selected source, then paste through the production clipboard bridge.
  await selection(0,source.length);await key('c',67,2);await evaluate("lab.reset('')");await key('v',86,2);await settle();assert.equal(await evaluate('lab.source()'),source);
  await key('z',90,2);assert.equal(await evaluate('lab.source()'),'');await key('y',89,2);assert.equal(await evaluate('lab.source()'),source);
  // Host structured selections still become a reference; raw paste bypasses it.
  await evaluate("lab.reset('');window.oldRead=lab.production.options.clipboard.read;lab.production.options.clipboard.read=async purpose=>({text:'literal text',contextAttached:purpose==='code',...(purpose==='code'?{codeReference:{expression:'@src/a.ts#L1,1-L2,2',payload:'src/a.ts#L1,1-L2,2'}}:{})})");
  await key('v',86,2);await settle();assert.equal(await evaluate('lab.source()'),'@src/a.ts#L1,1-L2,2 ');
  await evaluate("lab.reset('')");await key('V',86,10);await settle();assert.equal(await evaluate('lab.source()'),'literal text');
  await evaluate('lab.production.options.clipboard.read=oldRead');
  // Real composition commits text at each side of an atomic reference.
  for(const side of ['sourceFrom','sourceTo']) {
    await evaluate('lab.reset('+JSON.stringify(source)+');lab.position(lab.refs()[0].'+side+')');
    const offset=await evaluate('lab.refs()[0].'+side);
    await send('Input.imeSetComposition',{text:'zhongwen',selectionStart:8,selectionEnd:8});
    await send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});await send('Input.insertText',{text:'中文'});await settle();
    assert.equal(await evaluate('lab.source()'),source.slice(0,offset)+'中文'+source.slice(offset));
  }
  // Browser mouse selection in both directions crosses complete source references.
  await evaluate('lab.reset('+JSON.stringify(source)+')');
  const points=await evaluate("{const r=lab.refs()[0];const point=offset=>{const p=lab.editor.getScrolledVisiblePosition(lab.model.getPositionAt(offset));const box=document.getElementById('editor').getBoundingClientRect();return {x:box.left+p.left,y:box.top+p.top+p.height/2};};[point(r.viewFrom-1),point(r.viewTo+1)]}");
  for(const [a,b] of [points,[...points].reverse()]) {
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...a,button:'left',clickCount:1});
    for(let i=1;i<=5;i++)await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:a.x+(b.x-a.x)*i/5,y:a.y+(b.y-a.y)*i/5,buttons:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...b,button:'left',clickCount:1});await settle();
    assert.ok(await evaluate("lab.projection.decode(lab.model.getValueInRange(lab.editor.getSelection())).includes('@src/界面/a.ts#L1,1-L3,4')"));
  }
  // Chat Enter sends; Code Enter inserts a line; Shift+Enter always inserts a line.
  await evaluate("lab.production.setMode("chat");lab.reset('hello');lab.position(5);lab.assistance.runs=0");await key('Enter',13);assert.equal(await evaluate('lab.assistance.runs'),1);
  await key('Enter',13,8);assert.equal(await evaluate('lab.source()'),'hello\n');
  await evaluate("lab.production.setMode("code");lab.reset('hello');lab.position(5)");await key('Enter',13);assert.equal(await evaluate('lab.assistance.runs'),1);assert.equal(await evaluate('lab.source()'),'hello\n');
  // Native @ suggestions operate in chat mode and Enter accepts rather than sends.
  await evaluate("lab.production.setMode("chat");lab.reset('@');lab.position(1);lab.production.triggerSuggest()");await settle();await key('Enter',13);await settle();assert.ok((await evaluate('lab.source()')).includes('@src/'));assert.equal(await evaluate('lab.assistance.runs'),1);
  // Identical draft switch must invalidate pending clipboard work.
  await evaluate("lab.reset('draft');window.releasePaste=undefined;lab.production.options.clipboard.read=()=>new Promise(resolve=>releasePaste=resolve);lab.position(5)");await key('v',86,2);
  await evaluate("lab.reset('draft');releasePaste({text:'late',contextAttached:false});lab.production.options.clipboard.read=oldRead");await settle();assert.equal(await evaluate('lab.source()'),'draft');
  // A file drop goes through the production DOM listener without requiring Shift.
  await evaluate(`lab.production.setMode("chat");lab.reset('');window.oldDrop=lab.production.options.resolveDroppedFiles;
    lab.production.options.resolveDroppedFiles=async()=>['@scripts/','@src/界面/a.ts'];
    {const data=new DataTransfer();data.setData('application/vnd.code.uri-list','file:///C:/project/scripts\\nfile:///C:/project/src/a.ts');
    const target=document.querySelector('#editor textarea');const box=target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,shiftKey:false,dataTransfer:data,clientX:box.left+2,clientY:box.top+2}));}`);
  await settle();assert.equal(await evaluate('lab.source()'),'@scripts/ @src/界面/a.ts ');
  assert.equal(await evaluate("document.querySelectorAll('.dext-ref-chip').length"),2,'file drop renders root directory and file chips');
  await key('z',90,2);assert.equal(await evaluate('lab.source()'),'');await key('y',89,2);await settle();
  assert.equal(await evaluate("document.querySelectorAll('.dext-ref-chip').length"),2,'file drop redo restores chips');
  await evaluate('lab.production.options.resolveDroppedFiles=oldDrop');
  // Verify production styles and all host theme classes in a narrow editor.
  await evaluate("{const style=document.createElement('style');style.textContent="+JSON.stringify(await readFile('media/styles.css','utf8'))+";document.head.append(style);document.getElementById('editor').classList.add('code-editor');}");
  for(const theme of ['vscode-light','vscode-dark','vscode-high-contrast','vscode-high-contrast-light']) {
    await evaluate("document.body.className='"+theme+"';document.documentElement.dataset.theme='"+({ 'vscode-light':'vs','vscode-dark':'vs-dark','vscode-high-contrast':'hc-black','vscode-high-contrast-light':'hc-light'}[theme])+"';lab.production.setMode("code");lab.reset();lab.editor.updateOptions({wordWrap:'on'});document.getElementById('width').value='320';document.getElementById('width').dispatchEvent(new Event('change'));window.scrollTo(0,0)");await settle();
    await evaluate(`document.body.style.setProperty('--vscode-textLink-foreground','${theme.includes('light')?'#173e67':'#c2e1ff'}');document.body.style.setProperty('--vscode-textCodeBlock-background','${theme.includes('light')?'#e3effb':'#26415f'}');document.body.style.background='var(--page-bg)';document.body.style.color='var(--text)';`);await settle();
    const counts=await evaluate("lab.refs().map((_,i)=>document.querySelectorAll('.ref-open-'+i).length)");assert.ok(counts.every(n=>n===1));
    const colors=await evaluate("{const s=getComputedStyle(document.querySelector('.dext-ref-chip'));({fg:s.color,bg:s.backgroundColor})}");
    const luminance=color=>color.match(/\d+/g).slice(0,3).map(Number).map(n=>n/255).map(n=>n<=.04045?n/12.92:((n+.055)/1.055)**2.4).reduce((sum,n,i)=>sum+n*[.2126,.7152,.0722][i],0);
    const a=luminance(colors.fg),b=luminance(colors.bg);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,'theme label contrast '+theme);
    const shot=await send('Page.captureScreenshot');await writeFile(join(artifacts,theme+'.png'),Buffer.from(shot.data,'base64'));
  }

  await evaluate("lab.reset('前 @src/非常非常非常非常非常非常长的中文文件名称.ts 后');lab.editor.updateOptions({fontSize:24,wordWrap:'on'});lab.editor.layout();");await settle();
  assert.equal(await evaluate("document.querySelectorAll('.ref-open-0').length"),1,'long Chinese labels stay whole with large fonts');
  await evaluate("lab.production.options.parent.style.display='none'");await settle();await evaluate("lab.production.options.parent.style.display='';lab.editor.layout()");await settle();
  assert.ok(await evaluate("document.querySelector('.ref-open-0').getBoundingClientRect().width>0"),'editor recovers after hidden layout');
  // Dispose frees models and providers; no late callback may mutate a new draft.
  const before=await evaluate('lab.monaco.editor.getModels().length');await evaluate('lab.production.destroy()');await settle();assert.equal(await evaluate('lab.monaco.editor.getModels().length'),before-1);
  console.log('PASS references, multi-cursor history, clipboard, composition, drag selection, modes, draft isolation, themes and disposal');
});

