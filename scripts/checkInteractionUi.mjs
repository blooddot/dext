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
  const key = async (key, code, modifiers = 0) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key, windowsVirtualKeyCode: code, modifiers, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) }); await send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code, modifiers }); };
  /** Replaces a field's answer through real keyboard input: the chip surface is a
   * Monaco editor, so assigning `.value` no longer means anything. */
  const fillField = async (target, text, lineBreak = false) => {
    await evaluate(`${target}.focus()`);
    await key("a", 65, 2); await key("Delete", 46);
    if (text) await send("Input.insertText", { text });
    if (lineBreak) await key("Enter", 13);
    await evaluate("new Promise((done)=>requestAnimationFrame(()=>requestAnimationFrame(done)))");
  };
  const bundle = await build({ stdin: { contents: 'export { AgentInputView } from "./src/features/conversations/browser/agentInputView.ts"; export { InteractionForm } from "./src/features/conversations/browser/interactionForm.ts"; export { InteractionDialog } from "./src/features/conversations/browser/interactionDialog.ts"; export { uiCallForm, parseUiForm } from "./src/shared/contracts/uiForm.ts";', resolveDir: process.cwd() }, bundle: true, write: false, format: "iife", globalName: "InteractionUI" });
  await evaluate(bundle.outputFiles[0].text);
  // Mermaid is a separate lazy bundle. This harness has no server, so evaluate it
  // once and let `markdownDiagrams.ts` use the renderer it installs on globalThis;
  // the CSP below then applies to the SVG that renderer produces.
  const mermaidBundle = await build({ entryPoints: ["src/webview/mermaid.ts"], bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true, logLevel: "silent" });
  await evaluate(mermaidBundle.outputFiles[0].text);
  // A form answer is the Composer's chip surface, so the check needs the real
  // editor and the styles Monaco ships with it.
  const referenceBundle = await build({ stdin: { contents: 'export { ReferenceField } from "./src/webview/referenceField.ts";', resolveDir: process.cwd() }, bundle: true, write: false, outdir: "dist/webview-check", platform: "browser", format: "iife", globalName: "ReferenceUI", target: "es2022", minify: true, logLevel: "silent", loader: { ".ttf": "file" }, assetNames: "assets/[name]-[hash]" });
  const referenceScript = referenceBundle.outputFiles.find((file) => file.path.endsWith(".js"));
  const referenceStyles = referenceBundle.outputFiles.find((file) => file.path.endsWith(".css"));
  await evaluate(referenceScript.text);
  await evaluate(`document.body.innerHTML='<button id="previous">Previous focus</button><main id="turn"></main><details id="process"><summary>Process</summary></details>'; window.replies=[];window.saved={};
    // A chip that wraps at a line break is painted as two spans, only the first one
    // naming its reference, so count references rather than spans.
    window.chips=(root)=>new Set([...root.querySelectorAll('.dext-ref-chip')].map(chip=>(chip.className.match(/ref-open-([0-9]+)/)??[])[1]).filter((index)=>index!==undefined)).size;
    window.waitChips=(root,expected)=>new Promise((done)=>{const deadline=Date.now()+5000;const check=()=>{const count=chips(root);if(count===expected||Date.now()>deadline)done(count);else setTimeout(check,25);};check();});
    window.clipboardStub={read:async()=>undefined};
    window.formFiles={resolve:async(paths)=>paths.map(path=>'@'+path.split('/').pop()),attach:async()=>'.dext-global/attachments/p.png',onError:(error)=>{throw error;},referenceField:(options)=>new ReferenceUI.ReferenceField(formFiles,clipboardStub,options)};
    window.createView=()=>{const view=new InteractionUI.AgentInputView((id,answers)=>replies.push({id,answers}),(state,result)=>replies.push({id:state.requestId,result}),'test',{get:key=>saved[key],set:(key,draft)=>{saved[key]=draft}},formFiles);document.getElementById('turn').append(view.element);view.setRunning(true);return view;};
    window.view=createView();window.state=(id,form)=>({sessionId:'session',turnId:'turn',requestId:id,status:'waiting',form});`);
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify((await readFile('media/styles.css', 'utf8')) + "\n" + (referenceStyles?.text ?? ""))};document.head.append(style);const theme=document.createElement('style');theme.id='theme';document.head.append(theme);}`);
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
  await fillField(`view.element.querySelector('.interaction-reference-field textarea')`, "  notes", true);
  assert.equal(await evaluate(`view.element.querySelector('button[type=submit]').disabled`), false);
  await evaluate(`view.element.querySelector('.interaction-select > button').click();view.suspend();`);
  assert.equal(await evaluate(`document.querySelectorAll(':popover-open').length`), 0);
  await evaluate(`view.element.remove();view=createView();view.updateUi(state('mixed',mixed));`);
  assert.equal(await evaluate(`saved['test:ui:mixed'].text.value`), "  notes\n");
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
  await evaluate(`window.lineField=view.element.querySelector('.interaction-reference-field')`);
  assert.equal(await evaluate(`lineField.querySelector('.editorPlaceholder').textContent`), "Type here");
  assert.equal(await evaluate(`view.focusRequest('ui','input')`), true);
  assert.equal(await evaluate(`document.activeElement === lineField.querySelector('textarea')`), true, "notification focuses the requested input");
  await key("Tab", 9);
  assert.equal(await evaluate(`lineField.contains(document.activeElement)`), false, "Tab leaves a single-line answer");
  await evaluate(`lineField.querySelector('textarea').focus()`);
  await evaluate(`{const data=new DataTransfer();data.setData('text/uri-list','file:///repo/a.ts');const target=lineField.querySelector('textarea');
    target.dispatchEvent(new DragEvent('dragover',{dataTransfer:data,bubbles:true,cancelable:true}));
    target.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));}`);
  assert.equal(await evaluate(`waitChips(lineField,1)`), 1, "a single-line answer renders the chip too");
  assert.equal(await evaluate(`lineField.getBoundingClientRect().height <= 40`), true, "a single-line answer keeps the input height");
  const lineScreenshot = await send("Page.captureScreenshot");
  await writeFile(join(artifacts, "reference-line.png"), Buffer.from(lineScreenshot.data, "base64"));
  await fillField(`lineField.querySelector('textarea')`, "two" + String.fromCharCode(10) + "lines");
  assert.equal(await evaluate(`lineField.querySelectorAll('.view-line').length`), 1, "a multi-line paste keeps one line");
  await key("Enter", 13);
  assert.equal(await evaluate(`replies.at(-1).result.answers.answer.value`), "two lines", "Enter submits a single-line answer");
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
    await evaluate(`window.reviewForm=[...document.querySelectorAll('form')].find(form=>form.querySelector('.interaction-reference-field'));window.revise=[...reviewForm.querySelectorAll('button')].find(button=>button.textContent==='补充说明，重新分析');window.approve=reviewForm.querySelector('button[type=submit]');`);
    assert.equal(await evaluate(`revise.disabled`), true, `${presentation}: empty feedback disables revise`);
    assert.equal(await evaluate(`approve.disabled`), false, `${presentation}: approval needs no feedback`);
    assert.equal(await evaluate(`reviewForm.querySelector('.interaction-error').textContent`), "");
    await evaluate(`revise.click()`);
    assert.equal(await evaluate(`replies.length`), count);
    await fillField(`reviewForm.querySelector('.interaction-reference-field textarea')`, " ", true);
    assert.equal(await evaluate(`revise.disabled`), true, `${presentation}: whitespace is not feedback`);
    await fillField(`reviewForm.querySelector('.interaction-reference-field textarea')`, "补充线索");
    assert.equal(await evaluate(`revise.disabled`), false);
    await key("Enter", 13);
    assert.equal(await evaluate(`replies.length`), count, "multiline Enter does not submit approval");
    await evaluate(`revise.click()`);
    assert.equal(await evaluate(`replies.length`), count + 1);
    assert.equal(await evaluate(`replies.at(-1).result.action`), "revise");
    assert.equal(await evaluate(`view.element.textContent.includes('Submitted (补充说明，重新分析)')`), true);
    assert.equal(await evaluate(`replies.at(-1).result.answers.feedback.value.trim()`), "补充线索");
    await evaluate(`view.updateUi({...reviewState,status:'submitted',answers:replies.at(-1).result.answers});reviewState={...reviewState,requestId:'approve-${presentation}'};view.updateUi(reviewState);`);
    await evaluate(`[...document.querySelectorAll('form')].find(form=>form.querySelector('.interaction-reference-field')).querySelector('button[type=submit]').click()`);
    assert.deepEqual(await evaluate(`replies.at(-1).result`), { kind: "ui", type: "form", status: "submitted", action: "approve", answers: {} });
    await evaluate(`view.updateUi({...reviewState,status:'submitted',answers:{}});reviewState={...reviewState,requestId:'primary-revise-${presentation}',form:InteractionUI.parseUiForm({...reviewState.form,actions:[{id:'revise',label:'Revise',requires:['feedback'],primary:true},{id:'approve',label:'Approve'}]})};view.updateUi(reviewState);window.reviewForm=[...document.querySelectorAll('form')].find(form=>form.querySelector('.interaction-reference-field'));reviewForm.requestSubmit();`);
    assert.equal(await evaluate(`replies.length`), count + 2, "programmatic submission cannot bypass requires");
    assert.match(await evaluate(`reviewForm.querySelector('.interaction-error').textContent`), /enter a value/);
    await fillField(`reviewForm.querySelector('.interaction-reference-field textarea')`, "More context");
    assert.equal(await evaluate(`reviewForm.querySelector('button[type=submit]').disabled`), false);
    await fillField(`reviewForm.querySelector('.interaction-reference-field textarea')`, "");
    assert.equal(await evaluate(`reviewForm.querySelector('button[type=submit]').disabled`), true, "clearing feedback disables the action again");
    await evaluate(`view.updateUi({...reviewState,status:'cancelled'});`);
    // The closed form releases its editor, so there is no field left to type into.
    assert.equal(await evaluate(`reviewForm.querySelectorAll('.interaction-reference-field textarea').length`), 0);
    await evaluate(`reviewForm.requestSubmit();`);
    assert.equal(await evaluate(`replies.length`), count + 2, "closed controls cannot send a stale response");
    assert.equal(await evaluate(`reviewForm.querySelector('button[type=submit]').disabled`), true);
  }
  // Use the actual sidebar policy and intercepted HTTPS responses so a renderer
  // that creates <img> but cannot load it under Webview CSP fails this check.
  const sidebarSource = await readFile("src/app/sidebarProvider.ts", "utf8");
  const policy = sidebarSource.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy);
  await evaluate(`{const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content=${JSON.stringify(policy.replaceAll('${webview.cspSource}', 'https://webview.test').replaceAll('${nonce}', 'test'))};document.head.append(meta);
    const style=document.createElement('style');style.textContent=${JSON.stringify(await readFile('dist/markdown/github-markdown.css', 'utf8'))};document.head.append(style);document.body.classList.add('vscode-dark');}`);
  const imageRequests = [];
  let intercepting = false;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!intercepting || message.method !== "Fetch.requestPaused") return;
    const { requestId, request } = message.params;
    imageRequests.push(request.url);
    const failed = request.url.includes("expired");
    void send("Fetch.fulfillRequest", { requestId, responseCode: failed ? 403 : 200,
      responseHeaders: [{ name: "Content-Type", value: "image/svg+xml" }],
      body: Buffer.from(failed ? "Expired" : '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="#4466aa"/></svg>').toString("base64") }).catch(() => undefined);
  });
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://attachments.test/*" }] });
  intercepting = true;
  const signedImage = "https://attachments.test/screenshot.svg?Signature=abc%2Bdef%3D&Expires=9999999999";
  await theme("#181818", "#dddddd", "#66aaff");
  const report = '## 根因\n\n**升级请求重复**\n\n- TouchStart\n- TouchEnd\n\n```js\nconst pending = true;\n```\n\n| 项目 | 结果 |\n| --- | --- |\n| 请求 | 重复 |\n\n![截图](' + signedImage + ')\n\n![已过期](https://attachments.test/expired.png)\n\n<script>window.markdownInjected=true</script>\n\n[unsafe](javascript:alert(1))';
  for (const presentation of ["inline", "dialog"]) {
    await evaluate(`window.markdownState=state('markdown-${presentation}',InteractionUI.parseUiForm({title:'任务详情',presentation:'${presentation}',description:${JSON.stringify(report)},fields:[]}));view.updateUi(markdownState);window.description=[...document.querySelectorAll('.interaction-description')].filter(description=>!description.closest('.agent-input-disclosure-body')).at(-1);`);
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
  intercepting = false;
  await send("Fetch.disable");
  const diagrams = [
    '```mermaid\nflowchart TD\n A[打开宠物] --> B{数据有效?}\n B -->|是| C[刷新属性]\n B -->|否| D[忽略]\n click A "javascript:alert(1)"\n```',
    '```mermaid\nflowchart TD\n A[unfinished\n```',
    '```mermaid\nclassDiagram\n class PetData {\n +int petId\n +Refresh() void\n }\n PetData <|-- PetDetail\n```',
    '```ts\nconst untouched = "flowchart TD";\n```',
  ].join('\n\n');
  for (const [presentation, themeClass] of [["inline", "vscode-dark"], ["dialog", "vscode-light"]]) {
    await theme(themeClass === 'vscode-light' ? '#ffffff' : '#181818', themeClass === 'vscode-light' ? '#222222' : '#dddddd', '#4488cc');
    await evaluate(`document.body.className='${themeClass}';window.diagramState=state('diagrams-${presentation}',InteractionUI.parseUiForm({title:'流程图与类图',presentation:'${presentation}',description:${JSON.stringify(diagrams)},fields:[]}));view.updateUi(diagramState);window.description=[...document.querySelectorAll('.interaction-description')].filter(description=>!description.closest('.agent-input-disclosure-body')).at(-1);`);
    assert.equal(await evaluate(`new Promise(resolve=>{const deadline=Date.now()+15000;const check=()=>{if(description.querySelectorAll('[data-diagram-state]').length===3)resolve(true);else if(Date.now()>deadline)resolve(false);else setTimeout(check,50);};check();})`), true, `${presentation}: all diagrams finish under Webview CSP`);
    assert.equal(await evaluate(`description.querySelectorAll('[data-diagram-state=ready] svg').length`), 2, `${presentation}: flowchart and class diagram render despite invalid sibling`);
    assert.equal(await evaluate(`description.querySelector('[data-diagram-state=ready] svg').textContent.includes('刷新属性')`), true);
    assert.equal(await evaluate(`description.querySelectorAll('[data-diagram-state=ready] svg')[1].textContent.includes('PetData')`), true);
    assert.equal(await evaluate(`description.querySelectorAll('[data-diagram-state=ready] details:not([open])').length`), 2);
    assert.equal(await evaluate(`description.querySelector('[data-diagram-state=error] details').open`), true);
    assert.equal(await evaluate(`description.querySelector('[data-diagram-state=error] code').textContent`), 'flowchart TD\n A[unfinished\n');
    assert.equal(await evaluate(`description.querySelector('code.language-ts').textContent`), 'const untouched = "flowchart TD";\n');
    assert.equal(await evaluate(`document.querySelectorAll('.markdown-diagram-staging').length`), 0, "rendering scratch DOM is cleaned up on success and error");
    assert.equal(await evaluate(`description.querySelectorAll('svg script, svg a[href^="javascript:"], svg [onclick]').length`), 0);
    assert.equal(await evaluate(`Array.from(description.querySelectorAll('svg')).every(svg=>svg.getBoundingClientRect().height>20)`), true);
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), true, "diagrams do not widen a narrow viewport");
    await evaluate(`description.scrollTop=0;description.querySelector('summary').click();`);
    assert.equal(await evaluate(`description.querySelector('details').open`), true, "diagram source can be expanded");
    await evaluate(`description.querySelector('summary').click();`);
    const screenshot = await send("Page.captureScreenshot"); await writeFile(join(artifacts, `diagrams-${presentation}.png`), Buffer.from(screenshot.data, "base64"));
    await evaluate(`view.updateUi({...diagramState,status:'cancelled'});`);
  }
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
  const sidebar = await readFile("src/app/sidebarProvider.ts", "utf8");
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
  // A field answer is text, so dropped files and pasted images both arrive as
  // `@path` at the caret the reader left behind.
  await evaluate(`window.fileHost={resolve:async(paths)=>paths.map(path=>'@'+path.split('/').pop()),attach:async()=>'.dext/attachments/p.png',onError:(error)=>{throw error;}};
    window.fileForm=new InteractionUI.InteractionForm(InteractionUI.parseUiForm({title:'Files',fields:[{id:'note',type:'input',label:'Note',multiline:true}]}),()=>{},{},()=>{},fileHost);
    document.body.append(fileForm.element);window.noteField=fileForm.element.querySelector('textarea');noteField.focus();`);
  await evaluate(`{const data=new DataTransfer();data.setData('text/uri-list','file:///repo/a.ts');
    noteField.dispatchEvent(new DragEvent('dragover',{dataTransfer:data,bubbles:true,cancelable:true}));
    noteField.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));}`);
  assert.equal(await evaluate(`new Promise(resolve=>setTimeout(()=>resolve(noteField.value),50))`), "@a.ts ");
  await evaluate(`{const data=new DataTransfer();data.items.add(new File(['x'],'p.png',{type:'image/png'}));
    noteField.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}`);
  assert.equal(await evaluate(`new Promise(resolve=>setTimeout(()=>resolve(noteField.value),50))`), "@a.ts @.dext/attachments/p.png ");
  assert.equal(await evaluate(`noteField.classList.contains('file-drop-active')`), false);
  await evaluate(`fileForm.element.remove()`);
  // The same field with the chip surface: the answer keeps the full path, the
  // reader sees the Composer's chip.
  const attachment = ".dext-global/attachments/6ba0ee58244ae270b77dd205.png";
  const codeReference = "src/review.ts#L3,1-L4,2";
  const feedback = `除了要滚动到对应天赋树节点外，还要打开那个节点的气泡说明 @${attachment} ，代码见 @${codeReference}`;
  await evaluate(`window.chipFiles={resolve:async(paths)=>paths.map(path=>'@'+path.split('/').pop()),attach:async()=>'.dext-global/attachments/p.png',onError:(error)=>{throw error;}};
    window.chipForm=new InteractionUI.InteractionForm(InteractionUI.parseUiForm({title:'Review',presentation:'dialog',fields:[{id:'feedback',type:'input',label:'补充说明',required:false,multiline:true}],actions:[{id:'revise',label:'补充说明，重新制定方案',requires:['feedback'],primary:true}]}),(result)=>{window.chipReply=result;},{feedback:{type:'input',value:${JSON.stringify(feedback)}}},()=>{},{...chipFiles,referenceField:(options)=>new ReferenceUI.ReferenceField(chipFiles,clipboardStub,options)});
    window.chipDialog=new InteractionUI.InteractionDialog(chipForm);document.body.append(chipDialog.element);chipDialog.open();window.chipEditor=chipForm.element.querySelector('.interaction-reference-field');`);
  assert.equal(await evaluate(`waitChips(chipEditor,2)`), 2, "attachment and code references each render one chip");
  assert.equal(await evaluate(`[...chipEditor.querySelectorAll('.dext-ref-chip')].some(chip=>chip.textContent.includes('review.ts 3-4'))`), true, "a code reference shows its compact label");
  assert.equal(await evaluate(`chipEditor.querySelector('.dext-ref-chip').textContent.includes('…')`), true, "a narrow field elides the chip label");
  const referenceScreenshot = await send("Page.captureScreenshot");
  await writeFile(join(artifacts, "reference-field.png"), Buffer.from(referenceScreenshot.data, "base64"));
  await evaluate(`{const data=new DataTransfer();data.items.add(new File(['x'],'p.png',{type:'image/png'}));
    chipEditor.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}`);
  assert.equal(await evaluate(`waitChips(chipEditor,3)`), 3, "a pasted image becomes a chip");
  await evaluate(`{const data=new DataTransfer();data.setData('text/uri-list','file:///repo/a.ts');const target=chipEditor.querySelector('textarea');
    target.dispatchEvent(new DragEvent('dragover',{dataTransfer:data,bubbles:true,cancelable:true}));
    target.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));}`);
  assert.equal(await evaluate(`waitChips(chipEditor,4)`), 4, "a dropped file becomes a chip");
  const chipBox = JSON.parse(await evaluate(`{const chip=[...chipEditor.querySelectorAll('.dext-ref-chip')].find(chip=>chip.textContent.includes('p.png'));const range=document.createRange();const close=chip.textContent.lastIndexOf('×');range.setStart(chip.firstChild,close);range.setEnd(chip.firstChild,close+1);const box=range.getBoundingClientRect();JSON.stringify({x:box.left+box.width/2,y:box.top+box.height/2})}`));
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: chipBox.x, y: chipBox.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: chipBox.x, y: chipBox.y, button: "left", clickCount: 1 });
  assert.equal(await evaluate(`waitChips(chipEditor,3)`), 3, "× removes just that reference");
  // A copy from a VS Code editor arrives as its `@path`, not as the code itself.
  const pastedCode = "export interface AgentProfile {\n  id: string;\n}";
  await evaluate(`window.clipboardStub.read=async()=>({text:'@src/review.ts#L5,1-L6,2',contextAttached:false,codeReference:{expression:'@src/review.ts#L5,1-L6,2',payload:'src/review.ts#L5,1-L6,2'}});
    {const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(pastedCode)});
    chipEditor.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}`);
  assert.equal(await evaluate(`waitChips(chipEditor,4)`), 4, "pasted editor code becomes a reference chip");
  assert.equal(await evaluate(`chipEditor.querySelector('textarea').value.includes('AgentProfile')`), false, "the copied file content never lands in the answer");
  await evaluate(`window.clipboardStub.read=async()=>undefined;
    {const data=new DataTransfer();data.setData('text/plain',' notes');
    chipEditor.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}`);
  assert.equal(await evaluate(`new Promise(done=>setTimeout(()=>done(chipEditor.querySelector('textarea').value.includes('notes')),50))`), true, "an ordinary paste keeps its text");
  await evaluate(`chipForm.element.querySelector('button[type=submit]').click()`);
  const chipAnswer = await evaluate(`chipReply.answers.feedback.value`);
  assert.equal(chipAnswer.includes(attachment), true, "an untouched path stays whole in the answer");
  assert.equal(chipAnswer.includes("attachments/p.png"), false, "the removed path is gone from the answer");
  assert.equal(chipAnswer.includes("@a.ts"), true, "a dropped file reaches the answer as @path");
  assert.equal(chipAnswer.includes(`@${codeReference}`), true, "a code reference keeps its range in the answer");
  assert.equal(chipAnswer.includes("@src/review.ts#L5,1-L6,2"), true, "a pasted code reference reaches the answer");
  assert.equal(chipAnswer.includes("AgentProfile"), false, "pasting code leaves no source text behind");
  await evaluate(`chipDialog.element.remove()`);
  console.log("PASS: shared fields, dropdown keyboard and bounds, radio/checkbox keyboard, forms, action requirements in inline/dialog forms, dropped files and pasted images in a form field, reference chips in single- and multiline answers, Markdown reports and HTTPS images under CSP, Mermaid flowcharts/classes and error recovery under CSP, duplicate submission, draft reconstruction, modal Escape/focus, native answers/secrets, 320px dark/light/contrast, MCP dialog. Screenshots: .tmp-tb/interaction-ui");
} finally {
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
