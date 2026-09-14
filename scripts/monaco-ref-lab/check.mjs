import { readFile, writeFile, mkdtemp, rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { startLab } from './serve.mjs';
import { fileURLToPath } from 'node:url';

export async function runLabChecks(extra = async () => {}, baseline = true) {

const candidates = [process.env.DEXT_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Set DEXT_BROWSER to a Chromium/Edge executable.');
const { server, url } = await startLab();
const profile = await mkdtemp(join(tmpdir(), 'dext-ref-check-'));
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const artifacts = resolve(import.meta.dirname, '../../.tmp-tb/monaco-ref-lab');
await mkdir(artifacts, { recursive: true });
const observations = [];
const errors = [];
let socket;
let shutdown;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await new Promise(done => setTimeout(done, 100)); }
  }
  if (!port) throw new Error('Browser debugging port did not start.');
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0; const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''));
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  shutdown = () => send('Browser.close');
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const settle = () => evaluate('new Promise(resolve=>setTimeout(resolve,100))');
  const key = async (key, code, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code, modifiers, ...(key === 'Enter' ? {text:'\r'} : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers });
    await settle();
  };
  const click = async selector => {
    const point = await evaluate(`{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing '+${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();({x:r.left+r.width/2,y:r.top+r.height/2})}`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await settle();
  };
  const record = (mode, test, pass, details) => { observations.push({ mode, test, pass, details }); console.log(`${pass ? 'PASS' : 'LIMITATION'} [${mode}] ${test}: ${JSON.stringify(details)}`); };
  await send('Runtime.enable');
  await send('Browser.grantPermissions', { origin: url, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate('Boolean(window.lab)')) break; await new Promise(done => setTimeout(done, 100)); }
  assert.equal(await evaluate('Boolean(window.lab)'), true, 'Monaco lab boots');

  if (baseline) {
  const source = 'agent(input="前 @src/features/workflow/components/main.ts#L12,5-L20,6 后")';
  const reset=async()=>{await evaluate('lab.reset('+JSON.stringify(source)+');window.ref=lab.refs()[0]');await settle();};
  for (const [name,keyName,code,at,modifiers] of [['left','ArrowLeft',37,'end',0],['right','ArrowRight',39,'start',0],['selection','ArrowLeft',37,'end',8],['backspace','Backspace',8,'end',0],['delete','Delete',46,'start',0]]) {
    await reset();await evaluate('lab.position(ref.reference.'+at+')');await key(keyName,code,modifiers);
    if(name==='left'||name==='right')assert.equal(await evaluate('lab.model.getOffsetAt(lab.editor.getPosition())'),await evaluate(name==='left'?'ref.viewFrom':'ref.viewTo'));
    else if(name==='selection')assert.equal(await evaluate('lab.projection.decode(lab.model.getValueInRange(lab.editor.getSelection()))'),await evaluate('ref.reference.expression'));
    else {assert.equal(await evaluate('lab.source()'),await evaluate('lab.sample')===source?'':source.slice(0,15)+source.slice(68));await key('z',90,2);assert.equal(await evaluate('lab.source()'),source);await key('y',89,2);assert.ok(!(await evaluate('lab.source()')).includes('@src/'));}
    console.log('PASS atomic '+name);
  }
  await reset();await evaluate('lab.position(ref.reference.end)');await key('ArrowLeft',37,8);await key('x',88,2);await key('z',90,2);assert.equal(await evaluate('lab.source()'),source);
  await reset();await evaluate('lab.select(ref.reference.start,ref.reference.end)');await key('c',67,2);await evaluate("document.getElementById('paste-target').focus()");await key('v',86,2);assert.equal(await evaluate("document.getElementById('paste-target').value"),await evaluate('ref.reference.expression'));
  await reset();await click('.ref-open-0');assert.equal(await evaluate('lab.events[0]'),'打开目标：src/features/workflow/components/main.ts#L12,5-L20,6');
  for(const width of [760,480,320]) {
    await evaluate("lab.reset();document.getElementById('width').value='"+width+"';document.getElementById('width').dispatchEvent(new Event('change'));window.scrollTo(0,0)");await settle();
    const fragments=await evaluate("lab.refs().map((ref,i)=>document.querySelectorAll('.ref-open-'+i).length)");
    assert.ok(fragments.every(count=>count===1),'unbroken labels at '+width+': '+fragments);
    const shot=await send('Page.captureScreenshot');await writeFile(join(artifacts,'projected-'+width+'.png'),Buffer.from(shot.data,'base64'));
    console.log('PASS wrapping '+width);
  }
  }
  await extra({send,evaluate,settle,key,click,artifacts});
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ monaco: '0.56.0', browser: await send('Browser.getVersion'), observations, errors,
    manualChecks: ['Physical Windows Chinese IME', 'Screen reader/button accessibility', 'Actual VS Code Webview worker/CSP loading'] }, null, 2));
  console.log(`Report and screenshots: ${artifacts}`);
} finally {
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise(done => setTimeout(done, 300));
  assert.ok(profile.startsWith(join(tmpdir(), 'dext-ref-check-')));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(error => console.warn(error.message));
  await new Promise(done => server.close(done));
}

}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runLabChecks();
