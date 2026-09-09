import { build } from "esbuild";
import { readFile, writeFile, mkdtemp, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const candidates = [process.env.DEXT_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error("Set DEXT_BROWSER to a Chromium/Edge executable.");
const profile = await mkdtemp(join(tmpdir(), "dext-interaction-"));
const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
let shutdown;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await new Promise((done) => setTimeout(done, 100)); }
  }
  if (!port) throw new Error("Browser debugging port did not start.");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); } });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  shutdown = () => send("Browser.close");
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const key = async (key, code) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: code, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) }); await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code }); };
  const bundle = await build({ stdin: { contents: 'export { AgentInputView } from "./src/webview/agentInputView.ts"; export { uiCallForm, parseUiForm } from "./src/core/uiForm.ts";', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "InteractionUI" });
  await evaluate(bundle.outputFiles[0].text);
  await evaluate(`document.body.innerHTML='<button id="previous">Previous focus</button><main id="turn"></main><details id="process"><summary>Process</summary></details>'; window.replies=[];window.saved={};
    window.createView=()=>{const view=new InteractionUI.AgentInputView((id,answers)=>replies.push({id,answers}),(state,result)=>replies.push({id:state.requestId,result}),'test',{get:key=>saved[key],set:(key,draft)=>{saved[key]=draft}});document.getElementById('turn').append(view.element);view.setRunning(true);return view;};
    window.view=createView();window.state=(id,form)=>({sessionId:'session',turnId:'turn',requestId:id,status:'waiting',form});`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('media/styles.css', 'utf8'))};document.head.append(style);const theme=document.createElement('style');theme.id='theme';document.head.append(theme);}`);
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: false });
  const theme = async (background, foreground, accent) => evaluate(`document.getElementById('theme').textContent=${JSON.stringify(`:root{--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-editor-background:${background};--vscode-sideBar-background:${background};--vscode-foreground:${foreground};--vscode-input-background:${background};--vscode-input-foreground:${foreground};--vscode-descriptionForeground:${foreground};--vscode-widget-border:${foreground};--vscode-focusBorder:${accent};--vscode-button-background:${accent};--vscode-button-foreground:${background};--vscode-list-inactiveSelectionBackground:${background};--vscode-errorForeground:${foreground}} body{background:${background};color:${foreground};padding:8px} main{min-width:0}`)}`);
  await theme("#181818", "#dddddd", "#66aaff");
  await evaluate(`window.mixed=InteractionUI.parseUiForm({title:'Settings',fields:[{id:'env',type:'select',label:'Environment',options:[{value:'dev',label:'Development',description:'Local environment'},'Production']},{id:'run',type:'radio',label:'Run checks?',options:['yes','no']},{id:'checks',type:'checkbox',label:'Checks',options:['types','tests'],allow_custom:true,required:false},{id:'text',type:'input',label:'Details',multiline:true,required:false}]}); view.updateUi(state('mixed',mixed));`);
  assert.equal(await evaluate(`view.element.querySelector('button[type=submit]').disabled`), true);
  await evaluate(`view.element.querySelector('.interaction-select > button').click()`);
  assert.equal(await evaluate(`document.querySelectorAll(':popover-open').length`), 1);
  await key("ArrowDown", 40); await key("Enter", 13);
  assert.equal(await evaluate(`document.querySelectorAll(':popover-open').length`), 0);
  await evaluate(`view.element.querySelector('input[type=radio]').focus()`); await key("ArrowRight", 39);
  await evaluate(`view.element.querySelector('input[type=checkbox]').focus()`); await key(" ", 32);
  await evaluate(`{const input=view.element.querySelector('textarea');input.value='  notes\\n';input.dispatchEvent(new Event('input'));}`);
  assert.equal(await evaluate(`view.element.querySelector('button[type=submit]').disabled`), false);
  await evaluate(`view.element.querySelector('.interaction-select > button').click();view.suspend();`);
  assert.equal(await evaluate(`document.querySelectorAll(':popover-open').length`), 0);
  await evaluate(`view.element.remove();view=createView();view.updateUi(state('mixed',mixed));`);
  assert.equal(await evaluate(`view.element.querySelector('textarea').value`), "  notes\n");
  assert.equal(await evaluate(`view.element.querySelectorAll('input[type=checkbox]:checked').length`), 1);
  const artifacts = resolve(".tmp-tb/interaction-ui"); await mkdir(artifacts, { recursive: true });
  for (const [name, background, foreground, accent] of [["dark", "#181818", "#ddd", "#66aaff"], ["light", "#fff", "#222", "#005fcc"], ["contrast", "#000", "#fff", "#ff0"]]) {
    await theme(background, foreground, accent);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `${name} overflow`);
    const screenshot = await send("Page.captureScreenshot"); await writeFile(join(artifacts, `${name}.png`), Buffer.from(screenshot.data, "base64"));
  }
  await evaluate(`view.element.querySelector('form').requestSubmit();view.element.querySelector('form').requestSubmit();`);
  assert.equal(await evaluate(`replies.length`), 1);
  assert.equal(await evaluate(`replies[0].result.answers.run.selected[0]`), "no");
  assert.equal(await evaluate(`replies[0].result.answers.text.value`), "  notes\n");
  await evaluate(`view.updateUi({...state('mixed',mixed),status:'submitted',answers:replies[0].result.answers});`);
  await evaluate(`view.updateUi(state('mixed',mixed));`);
  assert.equal(await evaluate(`view.element.querySelectorAll('form').length`), 0, "replayed waiting state cannot revive a submitted form");
  assert.equal(await evaluate(`view.element.textContent.includes('Submitted')`), true);
  await evaluate(`document.getElementById('previous').focus();window.dropdown=InteractionUI.uiCallForm('select',{label:'Targets',options:['one','two'],multiple:true});view.updateUi(state('dropdown',dropdown));`);
  await evaluate(`document.querySelector('dialog[open] .interaction-select > button').click()`);
  await key(" ", 32); await key("ArrowDown", 40); await key(" ", 32);
  assert.equal(await evaluate(`document.querySelectorAll('[role=option][aria-selected=true]').length`), 2);
  const bounds = await evaluate(`{const r=document.querySelector(':popover-open').getBoundingClientRect();JSON.stringify({left:r.left,right:r.right,top:r.top,bottom:r.bottom})}`);
  const box = JSON.parse(bounds); assert.ok(box.left >= 0 && box.right <= 320 && box.top >= 0 && box.bottom <= 640);
  await key("Escape", 27);
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 1);
  await key("Escape", 27);
  assert.equal(await evaluate(`replies.at(-1).result.status`), "cancelled");
  assert.equal(await evaluate(`document.activeElement.id`), "previous");
  await evaluate(`window.inputState=state('input',InteractionUI.uiCallForm('input',{label:'Text',placeholder:'Type here',presentation:'inline'}));view.updateUi(inputState);`);
  assert.equal(await evaluate(`view.element.querySelector('input[aria-label=Text]').placeholder`), "Type here");
  await evaluate(`view.element.querySelector('input[aria-label=Text]').closest('form').requestSubmit();`);
  assert.equal(await evaluate(`replies.at(-1).result.answers.answer.value`), "");
  await evaluate(`view.updateUi({...inputState,status:'submitted',answers:replies.at(-1).result.answers});
    window.radioState=state('custom-radio',InteractionUI.uiCallForm('radio',{label:'Radio',options:['a','b'],allow_custom:true,presentation:'inline'}));view.updateUi(radioState);
    {const input=view.element.querySelector('input[aria-label="Radio — Your answer"]');input.value='  custom  ';input.dispatchEvent(new Event('input'));input.closest('form').requestSubmit();}`);
  assert.deepEqual(await evaluate(`replies.at(-1).result.answers.answer`), { type: "radio", selected: [], custom: "  custom  " });
  await evaluate(`view.updateUi({...radioState,status:'submitted',answers:replies.at(-1).result.answers});
    window.checkState=state('custom-checkbox',InteractionUI.uiCallForm('checkbox',{label:'Checks',options:['a','b'],allow_custom:true,presentation:'inline'}));view.updateUi(checkState);
    {const input=view.element.querySelector('input[aria-label="Checks — Your answer"]');input.value='extra';input.dispatchEvent(new Event('input'));input.closest('form').querySelector('input[type=checkbox]').click();input.closest('form').requestSubmit();}`);
  assert.deepEqual(await evaluate(`replies.at(-1).result.answers.answer`), { type: "checkbox", selected: ["a"], custom: "extra" });
  await evaluate(`view.updateUi({...checkState,status:'submitted',answers:replies.at(-1).result.answers});`);
  await evaluate(`window.notice=state('notice',InteractionUI.uiCallForm('alert',{message:'Read this'}));view.updateUi(notice);`);
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open] .interaction-actions button').length`), 1);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 1, button: "left", clickCount: 1 });
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 1);
  await key("Escape", 27);
  assert.equal(await evaluate(`replies.at(-1).result.status`), "cancelled");
  await evaluate(`view.updateUi({...notice,status:'cancelled'});view.updateUi({...notice,requestId:'acknowledge'});`);
  await evaluate(`document.querySelector('dialog[open] button[type=submit]').click();`);
  assert.equal(await evaluate(`replies.at(-1).result.status`), "submitted");
  await evaluate(`window.agent=createView();agent.update({id:'native',blocking:false,status:'waiting',questions:[{id:'secret',question:'Secret',header:'',options:[],isSecret:true},{id:'pick',question:'Pick',header:'',options:[{label:'a',description:'Option A'}]}]});
    {const input=agent.element.querySelector('input[type=password]');input.value='private-value';input.dispatchEvent(new Event('input'));}
    agent.element.querySelector('input[type=radio]').click();agent.element.querySelector('form').requestSubmit();`);
  assert.equal(await evaluate(`JSON.stringify(saved).includes('private-value')`), false);
  assert.equal(await evaluate(`agent.element.querySelector('input[type=password]').value`), "");
  assert.deepEqual(await evaluate(`replies.at(-1).answers`), { secret: { answers: ["private-value"] }, pick: { answers: ["a"] } });
  await evaluate(`agent.update({id:'native',blocking:false,status:'answered',questions:[{id:'secret',question:'Secret',header:'',options:[],isSecret:true}],answers:{secret:{answers:['private-value']}}});`);
  assert.equal(await evaluate(`agent.element.textContent.includes('private-value')`), false);
  await evaluate(`view.setRunning(false);agent.setRunning(false);`);
  assert.equal(await evaluate(`document.querySelectorAll('input,textarea,dialog[open]').length`), 0);
  const sidebar = await readFile("src/sidebarProvider.ts", "utf8");
  for (const id of ["mcp-dialog", "mcp-assistant-dialog"]) {
    const template = sidebar.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?</dialog>`))?.[0];
    assert.ok(template, `${id} template exists`);
    await evaluate(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(template)});document.getElementById(${JSON.stringify(id)}).showModal();`);
    assert.equal(await evaluate(`document.querySelector('#${id} input, #${id} textarea').disabled`), false);
    const fits = await evaluate(`{const rect=document.getElementById('${id}').getBoundingClientRect();rect.left>=0 && rect.right<=innerWidth}`);
    assert.equal(fits, true, `${id} fits the narrow viewport`);
    assert.equal(await evaluate(`document.querySelectorAll('form form').length`), 0);
    await key("Escape", 27); assert.equal(await evaluate(`document.getElementById('${id}').open`), false);
    await evaluate(`document.getElementById('${id}').remove()`);
  }
  console.log("PASS: shared fields, dropdown keyboard and bounds, radio/checkbox keyboard, forms, duplicate submission, draft reconstruction, modal Escape/focus, native answers/secrets, 320px dark/light/contrast, MCP dialog. Screenshots: .tmp-tb/interaction-ui");
} finally {
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
