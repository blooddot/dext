import assert from 'node:assert/strict';
import { runLabChecks } from './monaco-ref-lab/check.mjs';
await runLabChecks(async ({evaluate,key,settle,send}) => {
  const type=async text=>{await send('Input.insertText',{text});await evaluate('new Promise(r=>setTimeout(r,220))');};
  const visible=()=>evaluate("Boolean(document.querySelector('.parameter-hints-widget.visible'))");
  await evaluate("lab.reset('agent(input=\"old\")');lab.position(15);lab.assistance.calls=[]");
  await type('x');await key('ArrowLeft',37);assert.equal(await visible(),false);
  assert.equal(await evaluate("lab.assistance.calls.filter(p=>p==='signature').length"),0);
  await evaluate("lab.reset('agent');lab.position(5)");await type('(');
  assert.equal(await visible(),true,'native opening-parenthesis trigger');
  await key('Escape',27);await type('input');assert.equal(await visible(),false,'ordinary edits do not revive hints');
  await evaluate('lab.production.triggerParameterHints()');await settle();assert.equal(await visible(),true,'explicit hints');
  await key('Escape',27);
  await evaluate("lab.reset('agent');lab.position(5);lab.assistance.hold=true");await type('(');await key('Escape',27);
  await evaluate('lab.assistance.hold=false;lab.assistance.pending.splice(0).forEach(resolve=>resolve())');await settle();
  assert.equal(await visible(),false,'late result remains dismissed');
  await evaluate("lab.reset('agent');lab.position(5);lab.assistance.hold=true");await type('(');
  await evaluate("lab.production.setMode("chat");lab.reset('hello');lab.assistance.hold=false;lab.assistance.pending.splice(0).forEach(resolve=>resolve())");await settle();
  assert.equal(await visible(),false,'mode change cancels help');
  await evaluate("lab.production.setMode("code");lab.reset('ag');lab.position(2);lab.production.triggerSuggest()");await settle();
  assert.ok(await evaluate("Boolean(document.querySelector('.suggest-widget.visible'))"),'native completion widget');
  await key('Escape',27);


  await evaluate(`lab.reset('agent(input="text")');lab.position(17)`);await type('(');assert.equal(await visible(),false,'literal parentheses do not start help');
  // Both Ctrl+click and F12 use the native definition provider. Querying is pure.
  await evaluate(`lab.reset('agent(input="@src/a.ts")');lab.position(2);window.opened=[];window.definitionQueries=0;lab.production.options.broker.definition=async()=>{definitionQueries++;return ({uri:'dext-mcp:/mcp-apis.dx?revision=1',content:'# MCP\\ndef test(): pass',originFrom:0,originTo:5,range:{startLineNumber:2,startColumn:5,endLineNumber:2,endColumn:9}});};lab.production.options.broker.openDefinition=(source,cursor)=>opened.push({source,cursor});`);
  await key('F12',123);await settle();assert.equal(await evaluate('opened.length'),1,'native F12 opens host definition');
  assert.ok((await evaluate('opened[0].source')).includes('@src/a.ts'));

  const point=await evaluate("{const p=lab.editor.getScrolledVisiblePosition({lineNumber:1,column:3}),r=document.getElementById('editor').getBoundingClientRect();({x:r.left+p.left,y:r.top+p.top+p.height/2})}");
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point,modifiers:2});await settle();
  assert.equal(await evaluate('opened.length'),1,'Ctrl hover only queries and previews');
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,modifiers:2,button:'left',clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,modifiers:2,button:'left',clickCount:1});await settle();
  assert.equal(await evaluate('opened.length'),2,'Ctrl click opens external definition');
  await evaluate(String.raw`lab.reset('def helper():\n    pass\n# @src/a.ts\nhelper()');lab.position(lab.source().lastIndexOf('helper')+2);lab.production.options.broker.definition=async()=>({uri:'dext-input:/composer.dx',originFrom:lab.source().lastIndexOf('helper'),originTo:lab.source().length-2,range:{startLineNumber:1,startColumn:5,endLineNumber:1,endColumn:11}});`);
  await key('F12',123);await settle();assert.equal(await evaluate('lab.editor.getPosition().lineNumber'),1,'local definition stays in composer');assert.equal(await evaluate('opened.length'),2);
  console.log('PASS native signature lifecycle, cancellation, mode changes and suggestions');
},false);
