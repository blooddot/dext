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
  const bundle = await build({ stdin: { contents: 'export { AgentInputView } from "./src/webview/agentInputView.ts"; export { InteractionForm } from "./src/webview/interactionForm.ts"; export { InteractionDialog } from "./src/webview/interactionDialog.ts"; export { uiCallForm, parseUiForm } from "./src/core/uiForm.ts";', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "InteractionUI" });
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
  await evaluate(`{const form=view.element.querySelector('form');form.requestSubmit();form.requestSubmit();}view.setRunning(false);view.setRunning(true);view.updateUi(state('mixed',mixed));`);
  assert.equal(await evaluate(`view.element.querySelectorAll('form').length`), 0, "local submission remains terminal before host acknowledgement");
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
  assert.equal(await evaluate(`view.focusRequest('ui','input')`), true);
  assert.equal(await evaluate(`document.activeElement === view.element.querySelector('input[aria-label=Text]')`), true, "notification focuses the requested input");
  await evaluate(`view.element.querySelector('input[aria-label=Text]').closest('form').requestSubmit();`);
  assert.equal(await evaluate(`replies.at(-1).result.answers.answer.value`), "");
  assert.equal(await evaluate(`view.focusRequest('ui','input')`), false, "answered requests cannot be focused again");
  await evaluate(`view.updateUi({...inputState,status:'submitted',answers:replies.at(-1).result.answers});
    window.radioState=state('custom-radio',InteractionUI.uiCallForm('radio',{label:'Radio',options:['a','b'],allow_custom:true,presentation:'inline'}));view.updateUi(radioState);
    {const input=view.element.querySelector('input[aria-label="Radio — Your answer"]');input.value='  custom  ';input.dispatchEvent(new Event('input'));input.closest('form').requestSubmit();}`);
  assert.deepEqual(await evaluate(`replies.at(-1).result.answers.answer`), { type: "radio", selected: [], custom: "  custom  " });
  await evaluate(`view.updateUi({...radioState,status:'submitted',answers:replies.at(-1).result.answers});
    window.checkState=state('custom-checkbox',InteractionUI.uiCallForm('checkbox',{label:'Checks',options:['a','b'],allow_custom:true,presentation:'inline'}));view.updateUi(checkState);
    {const input=view.element.querySelector('input[aria-label="Checks — Your answer"]');input.value='extra';input.dispatchEvent(new Event('input'));input.closest('form').querySelector('input[type=checkbox]').click();input.closest('form').requestSubmit();}`);
  assert.deepEqual(await evaluate(`replies.at(-1).result.answers.answer`), { type: "checkbox", selected: ["a"], custom: "extra" });
  await evaluate(`view.updateUi({...checkState,status:'submitted',answers:replies.at(-1).result.answers});`);
  for (const presentation of ["inline", "dialog"]) {
    const count = await evaluate(`replies.length`);
    await evaluate(`window.reviewState=state('review-${presentation}',InteractionUI.parseUiForm({title:'确认根因分析',presentation:'${presentation}',fields:[{id:'feedback',type:'input',label:'补充说明',required:false,multiline:true}],actions:[{id:'revise',label:'补充说明，重新分析',requires:['feedback']},{id:'approve',label:'确认，继续分析修复方案',primary:true}]}));view.updateUi(reviewState);`);
    await evaluate(`window.reviewForm=[...document.querySelectorAll('form')].find(form=>form.querySelector('textarea[aria-label="补充说明"]'));window.revise=[...reviewForm.querySelectorAll('button')].find(button=>button.textContent==='补充说明，重新分析');window.approve=reviewForm.querySelector('button[type=submit]');`);
    assert.equal(await evaluate(`revise.disabled`), true, `${presentation}: empty feedback disables revise`);
    assert.equal(await evaluate(`approve.disabled`), false, `${presentation}: approval needs no feedback`);
    assert.equal(await evaluate(`reviewForm.querySelector('.interaction-error').textContent`), "");
    await evaluate(`revise.click()`);
    assert.equal(await evaluate(`replies.length`), count);
    await evaluate(`{const input=reviewForm.querySelector('textarea');input.value=' \\n ';input.dispatchEvent(new Event('input'));}`);
    assert.equal(await evaluate(`revise.disabled`), true, `${presentation}: whitespace is not feedback`);
    await evaluate(`{const input=reviewForm.querySelector('textarea');input.value='补充线索';input.dispatchEvent(new Event('input'));input.focus();}`);
    assert.equal(await evaluate(`revise.disabled`), false);
    await key("Enter", 13);
    assert.equal(await evaluate(`replies.length`), count, "multiline Enter does not submit approval");
    await evaluate(`revise.click()`);
    assert.equal(await evaluate(`replies.length`), count + 1);
    assert.equal(await evaluate(`replies.at(-1).result.action`), "revise");
    assert.equal(await evaluate(`view.element.textContent.includes('Submitted (补充说明，重新分析)')`), true);
    assert.equal(await evaluate(`replies.at(-1).result.answers.feedback.value.trim()`), "补充线索");
    await evaluate(`view.updateUi({...reviewState,status:'submitted',answers:replies.at(-1).result.answers});reviewState={...reviewState,requestId:'approve-${presentation}'};view.updateUi(reviewState);`);
    await evaluate(`[...document.querySelectorAll('form')].find(form=>form.querySelector('textarea[aria-label="补充说明"]')).querySelector('button[type=submit]').click()`);
    assert.deepEqual(await evaluate(`replies.at(-1).result`), { kind: "ui", type: "form", status: "submitted", action: "approve", answers: {} });
    await evaluate(`view.updateUi({...reviewState,status:'submitted',answers:{}});reviewState={...reviewState,requestId:'primary-revise-${presentation}',form:InteractionUI.parseUiForm({...reviewState.form,actions:[{id:'revise',label:'Revise',requires:['feedback'],primary:true},{id:'approve',label:'Approve'}]})};view.updateUi(reviewState);window.reviewForm=[...document.querySelectorAll('form')].find(form=>form.querySelector('textarea[aria-label="补充说明"]'));reviewForm.requestSubmit();`);
    assert.equal(await evaluate(`replies.length`), count + 2, "programmatic submission cannot bypass requires");
    assert.match(await evaluate(`reviewForm.querySelector('.interaction-error').textContent`), /enter a value/);
    await evaluate(`{const input=reviewForm.querySelector('textarea');input.value='More context';input.dispatchEvent(new Event('input'));}`);
    assert.equal(await evaluate(`reviewForm.querySelector('button[type=submit]').disabled`), false);
    await evaluate(`{const input=reviewForm.querySelector('textarea');input.value='';input.dispatchEvent(new Event('input'));}`);
    assert.equal(await evaluate(`reviewForm.querySelector('button[type=submit]').disabled`), true, "clearing feedback disables the action again");
    await evaluate(`view.updateUi({...reviewState,status:'cancelled'});`);
    await evaluate(`{const input=reviewForm.querySelector('textarea');input.value='stale answer';input.dispatchEvent(new Event('input'));}reviewForm.requestSubmit();`);
    assert.equal(await evaluate(`replies.length`), count + 2, "closed controls cannot send a stale response");
    assert.equal(await evaluate(`reviewForm.querySelector('button[type=submit]').disabled`), true);
  }
  // Use the actual sidebar policy and intercepted HTTPS responses so a renderer
  // that creates <img> but cannot load it under Webview CSP fails this check.
  const sidebarSource = await readFile("src/sidebarProvider.ts", "utf8");
  const policy = sidebarSource.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy);
  await evaluate(`{const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content=${JSON.stringify(policy.replaceAll('${webview.cspSource}', 'https://webview.test').replaceAll('${nonce}', 'test'))};document.head.append(meta);
    const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/markdown/github-markdown.css', 'utf8'))};document.head.append(style);document.body.classList.add('vscode-dark');}`);
  const imageRequests = [];
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params;
    imageRequests.push(request.url);
    const failed = request.url.includes("expired");
    void send("Fetch.fulfillRequest", { requestId, responseCode: failed ? 403 : 200,
      responseHeaders: [{ name: "Content-Type", value: "image/svg+xml" }],
      body: Buffer.from(failed ? "Expired" : '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="#4466aa"/></svg>').toString("base64") });
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://attachments.test/*" }] });
  const signedImage = "https://attachments.test/screenshot.svg?Signature=abc%2Bdef%3D&Expires=9999999999";
  await theme("#181818", "#dddddd", "#66aaff");
  const report = '## 根因\n\n**升级请求重复**\n\n- TouchStart\n- TouchEnd\n\n```js\nconst pending = true;\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 请求 | 重复 |\n\n![截图](' + signedImage + ')\n\n![已过期](https://attachments.test/expired.png)\n\n<script>window.markdownInjected=true</script>\n\n[unsafe](javascript:alert(1))';
  for (const presentation of ["inline", "dialog"]) {
    await evaluate(`window.markdownState=state('markdown-${presentation}',InteractionUI.parseUiForm({title:'任务详情',presentation:'${presentation}',description:${JSON.stringify(report)},fields:[]}));view.updateUi(markdownState);window.description=document.querySelector('.interaction-description');`);
    assert.equal(await evaluate(`description.querySelector('h2').textContent`), "根因");
    assert.equal(await evaluate(`description.querySelector('strong').textContent`), "升级请求重复");
    assert.equal(await evaluate(`description.querySelectorAll('li').length`), 2);
    assert.equal(await evaluate(`description.querySelectorAll('pre code, table').length`), 2);
    assert.equal(await evaluate(`description.querySelectorAll('script, a[href^="javascript:"]').length`), 0);
    assert.equal(await evaluate(`window.markdownInjected===undefined`), true);
    assert.equal(await evaluate(`getComputedStyle(description).whiteSpace`), "normal");
    assert.equal(await evaluate(`parseFloat(getComputedStyle(description.querySelector('p')).marginBottom)>0`), true, "Markdown paragraph spacing survives form styles");
    await evaluate(`description.querySelector('img').scrollIntoView();`);
    assert.equal(await evaluate(`new Promise(resolve=>{const img=description.querySelector('img');if(img.complete)resolve(img.naturalWidth>0);else{img.addEventListener('load',()=>resolve(true),{once:true});img.addEventListener('error',()=>resolve(false),{once:true});setTimeout(()=>resolve(false),5000);}})`), true, `${presentation}: HTTPS image loads under CSP`);
    assert.equal(await evaluate(`description.querySelector('img').closest('a').getAttribute('href')`), signedImage);
    assert.equal(await evaluate(`description.querySelector('img').referrerPolicy`), "no-referrer");
    assert.equal(await evaluate(`description.querySelector('img').getBoundingClientRect().width<=description.clientWidth`), true);
    await evaluate(`description.querySelector('img[src*="expired"]')?.scrollIntoView()`);
    assert.equal(await evaluate(`new Promise(resolve=>{const check=()=>{if(description.querySelector('.interaction-image-error'))resolve(true);else setTimeout(check,50);};check();setTimeout(()=>resolve(false),5000);})`), true);
    assert.equal(await evaluate(`description.querySelector('.interaction-image-error').closest('a').href`), "https://attachments.test/expired.png");
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true);
    if (presentation === "dialog") assert.equal(await evaluate(`{const r=document.querySelector('dialog[open]').getBoundingClientRect();r.top>=0 && r.bottom<=innerHeight}`), true, "scrolling to images keeps the dialog within the viewport");
    await evaluate(`description.scrollTop=0;description.closest('form').scrollTop=0;description.closest('form').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const screenshot = await send("Page.captureScreenshot"); await writeFile(join(artifacts, `markdown-${presentation}.png`), Buffer.from(screenshot.data, "base64"));
    await evaluate(`view.updateUi({...markdownState,status:'cancelled'});`);
  }
  assert.ok(imageRequests.includes(signedImage), "signed image query reaches the server unchanged");
  await send("Fetch.disable");
  await evaluate(`window.optionalRadio=state('optional-radio',InteractionUI.parseUiForm({title:'Optional choice',fields:[{id:'pick',type:'radio',label:'Optional',required:false,options:['a','b']}]}));view.updateUi(optionalRadio);view.element.querySelector('input[type=radio]').click();view.element.querySelector('button[aria-label="Clear Optional"]').click();view.element.querySelector('form').requestSubmit();`);
  assert.deepEqual(await evaluate(`replies.at(-1).result.answers`), {}, "optional radio can return to unanswered");
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
    window.secretInput=agent.element.querySelector('input[type=password]');secretInput.value='private-value';secretInput.dispatchEvent(new Event('input'));
    agent.element.querySelector('input[type=radio]').click();`);
  assert.equal(await evaluate(`agent.element.querySelector('button[type=submit]').disabled`), false);
  await evaluate(`agent.suspend();agent.resume();`);
  assert.equal(await evaluate(`secretInput.value`), "");
  assert.equal(await evaluate(`agent.element.querySelector('button[type=submit]').disabled`), true, "clearing secrets on suspension refreshes validation");
  await evaluate(`secretInput.value='private-value';secretInput.dispatchEvent(new Event('input'));agent.element.querySelector('form').requestSubmit();`);
  assert.equal(await evaluate(`JSON.stringify(saved).includes('private-value')`), false);
  assert.equal(await evaluate(`secretInput.value`), "");
  assert.deepEqual(await evaluate(`replies.at(-1).answers`), { secret: { answers: ["private-value"] }, pick: { answers: ["a"] } });
  await evaluate(`agent.update({id:'native',blocking:false,status:'answered',questions:[{id:'secret',question:'Secret',header:'',options:[],isSecret:true}],answers:{secret:{answers:['private-value']}}});`);
  assert.equal(await evaluate(`agent.element.textContent.includes('private-value')`), false);
  await evaluate(`view.setRunning(false);agent.setRunning(false);`);
  assert.equal(await evaluate(`document.querySelectorAll('input,textarea,dialog[open]').length`), 0);
  await evaluate(`document.getElementById('previous').focus();window.focusDialog=new InteractionUI.InteractionDialog(new InteractionUI.InteractionForm(InteractionUI.uiCallForm('confirm',{message:'Focus check'}),()=>{}));document.body.append(focusDialog.element);focusDialog.open();focusDialog.close();window.nextFocus=document.createElement('button');document.body.append(nextFocus);nextFocus.focus();focusDialog.close();`);
  assert.equal(await evaluate(`document.activeElement===nextFocus`), true, "closing an already closed dialog does not steal focus");
  await evaluate(`focusDialog.element.remove();nextFocus.remove();`);
  const sidebar = await readFile("src/sidebarProvider.ts", "utf8");
  for (const id of ["mcp-assistant-dialog"]) {
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
  console.log("PASS: shared fields, dropdown keyboard and bounds, radio/checkbox keyboard, forms, action requirements in inline/dialog forms, Markdown reports and HTTPS images under CSP, duplicate submission, draft reconstruction, modal Escape/focus, native answers/secrets, 320px dark/light/contrast, MCP dialog. Screenshots: .tmp-tb/interaction-ui");
} finally {
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
