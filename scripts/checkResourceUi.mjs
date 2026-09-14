import { readFile, writeFile, mkdtemp, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { startLab } from "./monaco-ref-lab/serve.mjs";

const candidates = [process.env.DEXT_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error("Set DEXT_BROWSER to a Chromium/Edge executable.");
const {server,url}=await startLab();
const profile = await mkdtemp(join(tmpdir(), "dext-resource-ui-"));
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
  await send('Page.navigate',{url});
  for(let attempt=0;attempt<100;attempt++){if(await evaluate('Boolean(window.lab)'))break;await new Promise(done=>setTimeout(done,100));}
  await evaluate(`lab.production.destroy();document.head.querySelectorAll('link[rel=stylesheet]').forEach(link=>link.remove());
    {const meta=document.createElement('meta');meta.name='dext-editor-worker';meta.content='/assets/editor.worker.js';document.head.append(meta);}`);
  const template = await readFile("src/sidebarProvider.ts", "utf8");
  const body = template.slice(template.indexOf("<body>"), template.lastIndexOf("</body>") + 7).replace(/<script[\s\S]*?<\/script>/g, "");
  await evaluate(`document.body.outerHTML=${JSON.stringify(body)};window.sent=[];window.uiErrors=[];window.addEventListener('error', e=>uiErrors.push(e.message));window.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>({}),setState:()=>{}});window.host=m=>window.dispatchEvent(new MessageEvent('message',{data:m}));`);
  const font = (await readFile("dist/codicons/codicon.ttf")).toString("base64");
  const icons = (await readFile("dist/codicons/codicon.css", "utf8")).replace(/url\([^)]*\)/g, `url(data:font/ttf;base64,${font})`);
  const css = `${icons}\n${await readFile("dist/webview/main.css", "utf8")}`;
  await evaluate(`{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);}`);
  await evaluate(await readFile("dist/webview/main.js", "utf8"));
  await evaluate(`window.selection={profileId:'codex',mode:'agent',permission:'full-access',model:'test-model',reasoningEffort:'',speed:'',serviceTier:''};
    window.state={methods:[],diagnostics:[],mcpServers:[],globalDiagnostics:[],agentProfiles:[{id:'codex',provider:'codex',label:'Codex CLI',command:'codex',models:['test-model']}],agentSelection:selection,resourceRoots:{project:'C:/project/.dext',global:'C:/Users/Example/Dext/global'}};
    host({type:'state',state});
    window.resource={type:'api',scope:'project'};
    window.sessions=[{id:'chat',title:'Conversation',updatedAt:1,turnCount:0,pinned:false,running:false},{id:'resource',title:'New resource',updatedAt:1,turnCount:0,pinned:false,running:false}];
    window.activate=(id)=>{
      const r=id==='resource'?resource:undefined;
      host({type:'conversations',sessions,activeId:id,selection:{...selection,mode:r?'ask':'agent'},planStatus:'new',resource:r,hostInitiated:true});
      host({type:'outputSession',session:{id,createdAt:1,updatedAt:1,turns:[]},hostInitiated:true});
    };activate('chat');`);
  assert.equal(await evaluate(`document.getElementById('resource-toolbar').hidden`), true);
  await evaluate(`document.getElementById('create-resource').click()`);
  assert.equal(await evaluate(`sent.at(-1).type`), "openResourceCreator");
  await evaluate(`activate('resource')`);
  assert.equal(await evaluate(`document.getElementById('resource-toolbar').hidden`), false);
  assert.equal(await evaluate(`document.querySelector('dialog[open]')===null`), true);
  assert.equal(await evaluate(`document.getElementById('mode-control-value').textContent`), "API");
  assert.equal(await evaluate(`document.getElementById('permission-control-value').textContent`), "Project");
  assert.equal(await evaluate(`document.getElementById('resource-save').disabled`), true);
  await evaluate(`document.getElementById('mode-control').click()`);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#mode-menu button span')).map(x=>x.textContent)`), ["API", "MCP", "Rule", "Skill"]);
  await key("Escape", 27);
  await evaluate(`document.getElementById('permission-control').click()`);
  assert.equal(await evaluate(`document.getElementById('permission-menu').textContent.includes('C:/project/.dext/api')`), true);
  await key("Escape", 27);
  await evaluate(`document.querySelector('#code-editor textarea').focus()`);
  await send("Input.insertText", { text: "Create a reusable API" });
  await new Promise(done => setTimeout(done, 100));
  assert.equal(await evaluate(`document.getElementById('run').disabled`), false);
  await evaluate(`document.getElementById('run').click()`);
  assert.deepEqual(await evaluate(`sent.filter(x=>x.type==='executeInput').at(-1)`), {type:"executeInput",mode:"ask",source:"Create a reusable API"});
  await evaluate(`host({type:'executing',sessionId:'resource',value:true,turnId:'one',source:'Create a reusable API',startedAt:Date.now(),mode:'ask'})`);
  assert.equal(await evaluate(`document.getElementById('mode-control').disabled`), true);
  await evaluate(`document.getElementById('run').click()`);
  assert.deepEqual(await evaluate(`sent.at(-1)`), {type:"stopExecution",turnId:"one"});
  await evaluate(`host({type:'executing',sessionId:'resource',value:false,turnId:'one'});resource={type:'rule',scope:'project',target:{name:'review',path:'review.md',content:'Review changes.'},draft:{name:'review',content:'# Review\\n\\nReview changes and run checks.'}};host({type:'resourceContext',sessionId:'resource',resource});`);
  assert.equal(await evaluate(`document.getElementById('mode-control-value').textContent`), "Rule");
  assert.equal(await evaluate(`document.getElementById('resource-save').textContent`), "Save changes");
  assert.equal(await evaluate(`document.getElementById('resource-preview').textContent`), "View changes");
  await evaluate(`document.getElementById('permission-control').click()`);
  assert.equal(await evaluate(`document.getElementById('permission-menu').textContent.includes('Save as · Global')`), true);
  await key("Escape", 27);
  await evaluate(`document.getElementById('resource-preview').click()`);
  assert.deepEqual(await evaluate(`sent.at(-1)`), {type:"previewResource",sessionId:"resource"});
  await evaluate(`host({type:'resourceContext',sessionId:'resource',resource});document.getElementById('resource-save').click()`);
  assert.deepEqual(await evaluate(`sent.at(-1)`), {type:"saveResource",sessionId:"resource"});
  assert.equal(await evaluate(`document.getElementById('resource-save').disabled`), true);
  await evaluate(`activate('chat');host({type:'resourceContext',sessionId:'resource',resource:{...resource,saved:true}})`);
  assert.equal(await evaluate(`document.getElementById('resource-toolbar').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('permission-control-value').textContent`), "Full access");
  await evaluate(`activate('resource')`);
  assert.equal(await evaluate(`document.getElementById('mode-control-value').textContent`), "Rule");
  assert.equal(await evaluate(`document.querySelector('.monaco-editor .editorPlaceholder')?.textContent`), "Describe changes to review…");
  await evaluate(`host({type:'error',sessionId:'resource',message:'Changed on disk'});`);
  assert.equal(await evaluate(`document.getElementById('resource-status').textContent`), "Changed on disk");
  assert.equal(await evaluate(`document.getElementById('resource-save').disabled`), false);
  await evaluate(`document.getElementById('resource-save').click();resource={type:'rule',scope:'project',target:{...resource.target,content:resource.draft.content},saved:true};host({type:'resourceContext',sessionId:'resource',resource});`);
  assert.equal(await evaluate(`document.getElementById('resource-status').textContent`), "Saved");
  assert.equal(await evaluate(`document.getElementById('input-error').hidden`), true);
  assert.equal(await evaluate(`document.getElementById('resource-save').disabled`), true);
  assert.equal(await evaluate(`document.querySelector('.conversation-tab.active').dataset.sessionId`), "resource");
  const artifacts = resolve(".tmp-tb/resource-ui"); await mkdir(artifacts, { recursive: true });
  await evaluate(`document.querySelector('#code-editor textarea').focus()`);
  await send("Input.insertText", { text: "Refine this resource" });
  const appearances = [["api", "symbol-method"], ["mcp", "plug"], ["rule", "law"], ["skill", "book"]];
  for (const [name, themeClass, background, foreground, accent] of [
    ["dark", "vscode-dark", "#181818", "#ddd", "#66aaff"],
    ["light", "vscode-light", "#fff", "#222", "#005fcc"],
    ["contrast", "vscode-high-contrast", "#000", "#fff", "#ff0"],
    ["contrast-light", "vscode-high-contrast-light", "#fff", "#000", "#005fcc"]
  ]) {
    await evaluate(`document.body.className=${JSON.stringify(themeClass)};document.documentElement.style.cssText=${JSON.stringify(`--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;--vscode-editor-background:${background};--vscode-editor-foreground:${foreground};--vscode-sideBar-background:${background};--vscode-foreground:${foreground};--vscode-input-background:${background};--vscode-input-foreground:${foreground};--vscode-descriptionForeground:${foreground};--vscode-widget-border:${foreground};--vscode-menu-background:${background};--vscode-focusBorder:${accent};--vscode-button-background:${accent};--vscode-button-foreground:${background}`)}`);
    const colors = new Set();
    const disabledFills = new Set();
    for (const [type, icon] of appearances) {
      await send("Emulation.setDeviceMetricsOverride", { width: 760, height: 800, deviceScaleFactor: 1, mobile: false });
      await evaluate(`resource={type:${JSON.stringify(type)},scope:'project',target:{name:'example',path:'example.md',content:'Original'}};host({type:'resourceContext',sessionId:'resource',resource});`);
      disabledFills.add(await evaluate(`getComputedStyle(document.getElementById('resource-save')).backgroundColor`));
      await evaluate(`resource.draft={name:'example',content:'Revised'};host({type:'resourceContext',sessionId:'resource',resource});`);
      const appearance = await evaluate(`({
        label:getComputedStyle(document.getElementById('mode-control')).color,
        save:getComputedStyle(document.getElementById('resource-save')).backgroundColor,
        send:getComputedStyle(document.getElementById('run')).backgroundColor,
        target:getComputedStyle(document.getElementById('resource-target')).color,
        text:getComputedStyle(document.body).color,
        icon:document.getElementById('mode-control-icon').className,
        targetIcon:document.querySelector('#resource-target > i').className,
        mode:document.getElementById('input-section').dataset.mode
      })`);
      assert.equal(appearance.mode, "resource");
      assert.equal(appearance.icon, `codicon codicon-${icon}`);
      assert.equal(appearance.targetIcon, appearance.icon);
      assert.equal(appearance.save, appearance.send, `${name}/${type} action colors agree`);
      assert.equal(appearance.target, appearance.text, "Resource name stays neutral");
      if (!name.startsWith("contrast")) assert.equal(appearance.label, appearance.save);
      colors.add(appearance.label);
      await evaluate(`document.getElementById('mode-control').click()`);
      const items = await evaluate(`Array.from(document.querySelectorAll('#mode-menu button')).map(button=>({icon:button.querySelector('i').className,color:getComputedStyle(button).color,selected:button.getAttribute('aria-checked'),background:getComputedStyle(button).backgroundColor}))`);
      assert.deepEqual(items.map(item=>item.icon), appearances.map(([,glyph])=>`codicon codicon-${glyph}`));
      assert.equal(new Set(items.map(item=>item.color)).size, 4);
      assert.equal(items.find(item=>item.selected==='true').color, appearance.label);
      await evaluate(`document.querySelector('#mode-menu button[data-resource-type="${type}"]').focus()`);
      assert.equal(await evaluate(`getComputedStyle(document.activeElement).color`), appearance.label);
      if (name.startsWith("contrast")) assert.equal(await evaluate(`getComputedStyle(document.activeElement).outlineStyle`), "solid");
      await new Promise(done => setTimeout(done, 80));
      const screenshot = await send("Page.captureScreenshot"); await writeFile(join(artifacts, `${name}-${type}.png`), Buffer.from(screenshot.data, "base64"));
      await key("Escape", 27);
      await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
      await new Promise(done => setTimeout(done, 80));
      assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `${name}/${type} overflow`);
    }
    assert.equal(colors.size, 4, `${name}: each resource has a distinct theme color`);
    assert.equal(disabledFills.size, 1, `${name}: disabled saves stay neutral`);
    const screenshot = await send("Page.captureScreenshot"); await writeFile(join(artifacts, `${name}.png`), Buffer.from(screenshot.data, "base64"));
  }
  assert.deepEqual(await evaluate(`uiErrors`), []);
  console.log("PASS: resource tab entry, four resource types, save destinations, shared composer, stop, scoped preview/save, tab isolation, save failure/retry, retained saved tab, four distinct resource palettes/icons, synchronized action colors, neutral disabled actions, keyboard focus, narrow dark/light/high-contrast themes. Screenshots: .tmp-tb/resource-ui");
} finally {
  server.close();
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await new Promise((done) => setTimeout(done, 300));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
