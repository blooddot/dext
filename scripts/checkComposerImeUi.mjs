import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

await runLabChecks(async ({ evaluate, key, send, settle, artifacts }) => {
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('media/styles.css', 'utf8'))};document.head.append(style);document.getElementById('editor').classList.add('code-editor');}`);
  const source = '@.dext-global/attachments/example.png 重新加载插件';
  for (const width of [320, 760]) {
    for (const offset of [0, source.indexOf(' '), source.length]) {
      await evaluate(`lab.production.setMode("chat");document.documentElement.style.setProperty('--editor-width','${width}px');lab.editor.layout();lab.reset(${JSON.stringify(source)});lab.position(${offset});lab.assistance.runs=0`);
      for (const text of ['hou', '后']) {
        await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        await settle();
        assert.equal(await evaluate('lab.source()'), source.slice(0, offset) + text + source.slice(offset));
        const rendering = await evaluate(`{const ta=document.querySelector('#editor textarea.ime-input'),chip=document.querySelector('#editor .dext-ref-chip'),cursor=document.querySelector('#editor .cursors-layer > .cursor');({focused:document.activeElement===ta,opacity:getComputedStyle(ta).opacity,chipWidth:chip.getBoundingClientRect().width,markerDisplay:getComputedStyle(document.querySelector('#editor .dext-ref-source')).display,cursorVisibility:getComputedStyle(cursor).visibility})}`);
        assert.equal(rendering.focused, true, 'native IME retains focus');
        assert.equal(rendering.opacity, '0', 'native raw tokens do not cover the projected line');
        assert.ok(rendering.chipWidth > 20, 'reference stays rendered during composition');
        assert.equal(rendering.markerDisplay, 'none');
        assert.equal(rendering.cursorVisibility, 'visible', 'projected caret stays visible');
      }
      if (width === 760 && offset === source.length) {
        const shot = await send('Page.captureScreenshot');
        await writeFile(join(artifacts, 'composer-ime.png'), Buffer.from(shot.data, 'base64'));
      }
      assert.equal(await evaluate("lab.editor.getAction('dext.send').isSupported()"), false, 'send is disabled during composition');
      assert.equal(await evaluate("lab.editor.getAction('dext.newline').isSupported()"), false, 'IME owns Shift+Enter during composition');
      assert.equal(await evaluate('lab.assistance.runs'), 0, 'IME Enter never sends');
      await send('Input.insertText', { text: '后' });
      await settle();
      assert.equal(await evaluate('lab.source()'), source.slice(0, offset) + '后' + source.slice(offset));
      assert.equal(await evaluate("document.getElementById('editor').classList.contains('dext-reference-composition')"), false);
      await key('z', 90, 2);
      assert.equal(await evaluate('lab.source()'), source, 'composition undo preserves the reference');
    }
  }
  // Cancelled composition must restore the draft and normal input rendering.
  await evaluate(`lab.reset(${JSON.stringify(source)});lab.position(lab.source().length)`);
  await send('Input.imeSetComposition', { text: 'hou', selectionStart: 3, selectionEnd: 3 });
  await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await settle();
  assert.equal(await evaluate('lab.source()'), source);
  assert.equal(await evaluate("document.getElementById('editor').classList.contains('dext-reference-composition')"), false);
  // Whitespace from IME must not rewrite the model while composition is active.
  await evaluate("lab.reset('');lab.editor.trigger('keyboard','type',{text:'@src/a.ts'})");
  await send('Input.imeSetComposition', { text: ' 中文', selectionStart: 3, selectionEnd: 3 });
  await settle();
  assert.equal(await evaluate('lab.model.getValue()'), '@src/a.ts 中文');
  await send('Input.insertText', { text: ' 中文' });
  await settle();
  assert.equal(await evaluate('lab.source()'), '@src/a.ts 中文');
  assert.equal(await evaluate('lab.refs().length'), 1, 'deferred reference projects after composition');
  // Agent, Ask and Plan share the chat editor; cover both Enter preferences and Code.
  for (const language of [false, true]) {
    for (const submit of [false, true]) {
      await evaluate(`lab.production.setMode(${language ? "'code'" : "'chat'"});lab.production.setSubmitOnEnter(${submit});lab.reset('hello');lab.position(5);lab.assistance.runs=0`);
      await key('Enter', 13, 8);
      assert.deepEqual(await evaluate('lab.editor.getPosition()'), { lineNumber: 2, column: 1 });
      await send('Input.insertText', { text: 'world' });
      assert.equal(await evaluate('lab.source()'), 'hello\nworld', 'Shift+Enter moves typing to the new line');
      assert.equal(await evaluate('lab.assistance.runs'), 0);
      await key('z', 90, 2);
      assert.equal(await evaluate('lab.source()'), 'hello');
      await key('y', 89, 2);
      assert.equal(await evaluate('lab.source()'), 'hello\nworld');
    }
  }
  await evaluate("lab.production.setMode("chat");lab.reset('hello world');lab.select(5,6)");
  await key('Enter', 13, 8);
  await send('Input.insertText', { text: 'new ' });
  assert.equal(await evaluate('lab.source()'), 'hello\nnew world', 'newline replaces the selection and advances');
  await evaluate("lab.reset('a\\nb');lab.editor.setSelections([new lab.monaco.Selection(1,2,1,2),new lab.monaco.Selection(2,2,2,2)])");
  await key('Enter', 13, 8);
  await send('Input.insertText', { text: 'next' });
  assert.equal(await evaluate('lab.source()'), 'a\nnext\nb\nnext', 'newline advances all cursors');
  console.log('PASS active/cancelled IME rendering, deferred references, newline cursor, selection, multiple cursors and undo/redo');
}, false);
