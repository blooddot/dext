import assert from 'node:assert/strict';
import { runLabChecks } from './monaco-ref-lab/check.mjs';

// The composer's code hints come from Monaco's own TypeScript worker plus the
// generated `dext` declaration the host sends, so this lab checks the editor's
// native parameter-hints, suggestion and diagnosis behaviour instead of the
// hand-written provider the old language owned.
await runLabChecks(async ({ evaluate, key, settle, send }) => {
  const type = async (text) => { await send('Input.insertText', { text }); await evaluate('new Promise(r=>setTimeout(r,220))'); };
  const visible = () => evaluate("Boolean(document.querySelector('.parameter-hints-widget.visible'))");
  const suggestionsVisible = () => evaluate("Boolean(document.querySelector('.suggest-widget.visible'))");
  // The worker answers asynchronously over its own message channel, so a widget that is
  // about to appear must be waited for instead of sampled once.
  const hintsAppear = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await visible()) return true;
      await evaluate('new Promise(r=>setTimeout(r,150))');
    }
    return false;
  };
  const quiet = async () => { await evaluate('new Promise(r=>setTimeout(r,400))'); return visible(); };
  const suggestRows = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await suggestionsVisible()) return evaluate("[...document.querySelectorAll('.suggest-widget .monaco-list-row')].map(row=>row.textContent||'')");
      await evaluate('new Promise(r=>setTimeout(r,150))');
    }
    return [];
  };
  // Diagnostics arrive from the worker asynchronously; markers are what the editor paints.
  const markers = async () => { await evaluate('new Promise(r=>setTimeout(r,2000))'); return evaluate("lab.monaco.editor.getModelMarkers({}).map(marker=>String(marker.message))"); };

  // The composer's model has to *be* TypeScript: Monaco silently replaces an
  // unregistered language id with `plaintext`, which is what left the editor
  // without a single language feature while its mode badge still said Code.
  assert.equal(await evaluate("lab.model.getLanguageId()"), 'typescript', 'the composer model is really TypeScript');

  // The TypeScript service reads the declaration the host sends over `dextTypes`:
  // an export the declaration does not have is a diagnostic there, and a real one
  // is not, which is the whole difference between Code mode and a plain text box.
  await evaluate("lab.reset('import { nope } from \"dext\";')");
  const unknown = await markers();
  assert.ok(unknown.some(message => message.includes("no exported member 'nope'")),
    'an unknown dext export is diagnosed: ' + JSON.stringify(unknown));
  await evaluate("lab.reset('import { ask } from \"dext\";\\nvoid ask;')");
  const known = await markers();
  assert.ok(!known.some(message => /Cannot find module|has no exported member/.test(message)),
    'a declared API resolves: ' + JSON.stringify(known));

  // Ordinary edits do not open hints.
  await evaluate("lab.reset('const a = 1');lab.position(11)");
  await type('x');
  assert.equal(await quiet(), false, 'typing a value does not open parameter hints');

  // A call to a declared API has a signature, because the imported binding is
  // typed by the declaration the way any other module's export would be.
  await evaluate("lab.reset('import { ask } from \"dext\";\\nawait ask(');lab.position(lab.model.getValue().length);lab.production.triggerParameterHints()");
  assert.ok(await hintsAppear(), 'the TypeScript worker describes a declared signature');

  // Escape dismisses the widget and ordinary edits do not revive it.
  await key('Escape', 27);
  await type('input');
  assert.equal(await quiet(), false, 'ordinary edits do not revive hints');

  // The explicit command still opens it.
  await evaluate('lab.production.triggerParameterHints()');
  assert.ok(await hintsAppear(), 'explicit hints');
  await key('Escape', 27);

  // Suggestions are the editor's own widget, and the names in it are the declaration's:
  // this is what "code mode is plain TypeScript" buys at the import site. The prefix is
  // part of the buffer so the list is short enough for the widget to render it whole.
  await evaluate("lab.production.setMode('code');lab.reset('import { a } from \"dext\";');lab.position(10);lab.production.triggerSuggest()");
  const names = await suggestRows();
  assert.ok(names.some(name => name.includes('ask')), 'the declaration completes its exports: ' + JSON.stringify(names));
  await key('Escape', 27);

  // An unimported export is offered *with* the import that binds it, which is what the
  // workspace's own TypeScript service does and Monaco's worker cannot: it completes
  // without `includeCompletionsForModuleExports`, so `commit` would be nothing at all.
  await evaluate("lab.reset('commi');lab.position(5);lab.production.triggerSuggest()");
  const autoNames = await suggestRows();
  assert.ok(autoNames.some(name => name.includes('commit')), 'an unimported API export is offered: ' + JSON.stringify(autoNames));
  await key('Enter', 13);
  const accepted = await evaluate('lab.model.getValue()');
  assert.match(accepted, /import \{ commit \} from "dext\/api\/git\/commit";/, 'accepting it writes the import: ' + JSON.stringify(accepted));
  assert.match(accepted, /commit\s*$/, 'and leaves the typed name in place: ' + JSON.stringify(accepted));

  // A directory is not a symbol, so the old `.dx` spelling still completes nothing.
  await evaluate("lab.reset('git');lab.position(3);lab.production.triggerSuggest()");
  const gitRows = await suggestRows();
  assert.ok(!gitRows.some(name => name.includes('Auto import')), 'a directory name is offered nothing: ' + JSON.stringify(gitRows));

  // The other modes compose plain text: a question written in Agent or Chat mode must
  // not be answered with TypeScript symbols, which is what matching the URI scheme
  // alone used to do.
  await evaluate("lab.production.setMode('chat');lab.reset('commi');lab.position(5);lab.production.triggerSuggest()");
  const chatRows = await suggestRows();
  assert.equal(await evaluate("lab.model.getLanguageId()"), 'plaintext', 'chat mode is plain text');
  assert.ok(!chatRows.some(name => name.includes('commit') || name.includes('Auto import')),
    'chat mode offers no TypeScript symbols: ' + JSON.stringify(chatRows));
  await evaluate("lab.production.setMode('code')");

  // F12 stays inside the composer: the model and the editor survive it either way.
  await evaluate("lab.reset('import { ask } from \"dext\";\\nconst answer = await ask({ input: \"x\" });');const value=lab.model.getValue();lab.position(value.lastIndexOf('ask'))");
  const before = await evaluate('lab.editor.getPosition().lineNumber');
  await key('F12', 123);
  await settle();
  assert.equal(await evaluate('lab.editor.getPosition().lineNumber'), before, 'F12 keeps the composer open');

  // The composer paints the active VS Code theme, and that has to include the token types
  // only Monaco's tokenizer knows about: `identifier` is every name in the buffer and
  // `delimiter` is every brace, parenthesis and semicolon, and leaving them unmapped kept
  // them on Monaco's own colors while the editor beside them used the theme's.
  await evaluate("lab.production.applyTheme({identifier:{foreground:'#ff0000'},delimiter:{foreground:'#00ff00'}})");
  const painted = await evaluate(`(async()=>{
    const holder=document.createElement('span');holder.dataset.lang='typescript';
    holder.textContent='import { commit } from "dext/api/git/commit";';
    // The colorizer runs on a detached node, but a computed color needs a rendered one.
    await lab.monaco.editor.colorizeElement(holder,{theme:'dext'});
    document.body.append(holder);
    const color=(text)=>{const spans=[...holder.querySelectorAll('span')].filter(node=>node.textContent.includes(text));
      spans.sort((a,b)=>a.textContent.length-b.textContent.length);
      return spans.length?getComputedStyle(spans[0]).color:'';};
    const result={name:color('commit'),brace:color('{')};
    holder.remove();
    return JSON.stringify(result);})()`);
  const colors = JSON.parse(painted);
  assert.equal(colors.name, 'rgb(255, 0, 0)', 'a name takes the theme color: ' + painted);
  assert.equal(colors.brace, 'rgb(0, 255, 0)', 'a brace takes the theme color: ' + painted);
  console.log('PASS the composer paints the theme, names and braces included');
}, false);
