import assert from 'node:assert/strict';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

await runLabChecks(async ({ evaluate, key, settle }) => {
  const failures=[];
  const check=async(name,run)=>{try{await run();console.log('PASS '+name);}catch(error){failures.push(name+': '+error.message);console.error('FAIL '+name+': '+error.message);}};
  const text='first @src/a.ts\nsecond line';
  await check('find input owns its clipboard events',async()=>{
    await evaluate('lab.production.setMode("code");lab.reset('+JSON.stringify(text)+');lab.position(lab.source().length)');
    await key('f',70,2);await settle();
    await evaluate(`{const input=document.querySelector('.find-widget .find-part .input');input.focus();input.select();}navigator.clipboard.writeText('second')`);
    await key('v',86,2);await settle();
    assert.equal(await evaluate('lab.source()'),text,'find paste must not change the document');
    assert.equal(await evaluate("document.querySelector('.find-widget .find-part .input').value"),'second');
    await evaluate("document.querySelector('.find-widget .find-part .input').select()");await key('c',67,2);
    assert.equal(await evaluate('navigator.clipboard.readText()'),'second');
    await key('x',88,2);await settle();
    assert.equal(await evaluate('lab.source()'),text,'find cut must not change the document');
    assert.equal(await evaluate("document.querySelector('.find-widget .find-part .input').value"),'');
  });
  await key('Escape',27);
  await check('empty-selection copy/cut uses complete source lines',async()=>{
    await evaluate('lab.reset('+JSON.stringify(text)+');lab.position(1);navigator.clipboard.writeText("previous clipboard")');
    await key('c',67,2);await settle();
    assert.equal((await evaluate('navigator.clipboard.readText()')).replaceAll('\r\n','\n'),'first @src/a.ts\n');
    await key('x',88,2);await settle();
    assert.equal(await evaluate('lab.source()'),'second line');
    assert.equal((await evaluate('navigator.clipboard.readText()')).replaceAll('\r\n','\n'),'first @src/a.ts\n');
    await key('z',90,2);assert.equal(await evaluate('lab.source()'),text);
  });
  await check('late clipboard read does not steal focus from another input',async()=>{
    await evaluate(`lab.reset('draft');lab.position(5);window.originalRead=lab.production.options.clipboard.read;
      lab.production.options.clipboard.read=()=>new Promise(resolve=>window.finishPaste=resolve);`);
    await key('v',86,2);
    await evaluate(`{const input=document.createElement('input');input.id='other-input';document.body.append(input);input.focus();}finishPaste({text:'late text',contextAttached:false});`);
    await settle();assert.equal(await evaluate('lab.source()'),'draft');
    assert.equal(await evaluate('document.activeElement.id'),'other-input');
  });
  await evaluate('if(window.originalRead)lab.production.options.clipboard.read=originalRead;document.getElementById("other-input")?.remove();lab.reset()');
  assert.deepEqual(failures,[],'Monaco integration audit');
},false);
