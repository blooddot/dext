import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const candidates = [process.env.DEXT_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error("Set DEXT_BROWSER to a Chromium/Edge executable.");
const profile = await mkdtemp(join(tmpdir(), "dext-project-diagrams-"));
const browser = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
let server; let socket; let shutdown;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await sleep(500); }
  }
  if (!port) throw new Error("Browser debugging port did not start.");
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0; const pending = new Map();
  socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); } });
  const send = (method, params = {}) => new Promise((done, reject) => { const id = ++nextId; pending.set(id, { resolve: done, reject }); socket.send(JSON.stringify({ id, method, params })); });
  shutdown = () => send("Browser.close");
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };

  const bundle = await build({
    stdin: {
      contents: 'export { renderEditorTabHtml } from "./src/editorTabHtml.ts"; export { renderProjectPanel } from "./src/webview/projectPanel.ts"; export { archifyViewerBridgeScript } from "./src/webview/projectArchitectureView.ts"; export { ArchifyAdapter } from "./src/core/archifyAdapter.ts";',
      resolveDir: process.cwd()
    },
    bundle: true, write: false, platform: "node", format: "esm"
  });
  const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

  const evidence = (suffix) => [{ path: `src/${suffix}.ts`, line: 1 }];
  const node = (id, label, role, extra = {}) => ({ id, label, role, semanticIds: [], evidence: evidence(id), ...extra });
  const relation = (id, from, to, kind, extra = {}) => ({ id, from, to, kind, evidence: evidence(id), ...extra });
  const diagram = (kind, nodes, relations, semantics, extra = {}) => ({
    schemaVersion: 1, id: `demo-${kind}`, title: `示例 ${kind}`, kind, nodes, relations, semantics,
    version: 2, updatedAt: Date.now(), ...extra
  });
  const fixtures = {
    architecture: diagram("architecture",
      [node("web", "Web 前端", "system"), node("api", "API 服务", "service"), node("db", "数据库", "store")],
      [relation("r1", "web", "api", "calls", { label: "HTTPS", order: 1 }), relation("r2", "api", "db", "reads", { label: "SQL", order: 2 })],
      { boundaries: [{ id: "backend", label: "后端边界", kind: "region", nodeIds: ["api", "db"], evidence: evidence("api") }] }),
    workflow: diagram("workflow",
      [node("n1", "提交订单", "actor", { laneId: "customer" }), node("n2", "校验订单", "service", { laneId: "system" }), node("n3", "生成订单", "service", { laneId: "system" }), node("n4", "收到确认", "actor", { laneId: "customer" }), node("e1", "校验失败", "event", { laneId: "exception" })],
      [relation("x1", "n1", "n2", "calls", { label: "提交", order: 1 }), relation("x2", "n2", "n3", "calls", { label: "通过", order: 2, condition: "金额有效" }), relation("x3", "n2", "e1", "unknown", { label: "失败", order: 3, exception: true }), relation("x4", "n3", "n4", "returns", { label: "结果", order: 4 })],
      { lanes: [{ id: "customer", label: "客户", evidence: evidence("n1") }, { id: "system", label: "系统", evidence: evidence("n2") }, { id: "exception", label: "异常", variant: "exception", evidence: evidence("e1") }], mainPath: ["n1", "n2", "n3", "n4"] }),
    sequence: diagram("sequence",
      [node("u", "用户", "actor"), node("api", "API", "service"), node("db", "数据库", "store")],
      [relation("m1", "u", "api", "calls", { label: "登录请求", order: 1 }), relation("m2", "api", "db", "calls", { label: "查询用户", order: 2 }), relation("m3", "db", "api", "returns", { label: "用户记录", order: 3 }), relation("m4", "api", "u", "returns", { label: "令牌", order: 4 })],
      { participants: [{ nodeId: "u", order: 0 }, { nodeId: "api", order: 1 }, { nodeId: "db", order: 2 }], messages: [{ relationId: "m1", order: 1, kind: "call", evidence: evidence("m1") }, { relationId: "m2", order: 2, kind: "call", evidence: evidence("m2") }, { relationId: "m3", order: 3, kind: "return", evidence: evidence("m3") }, { relationId: "m4", order: 4, kind: "return", evidence: evidence("m4") }] }),
    data_flow: diagram("data_flow",
      [node("src", "数据源", "actor", { stageId: "s1" }), node("proc", "处理服务", "service", { stageId: "s2" }), node("store", "存储库", "store", { stageId: "s3" })],
      [relation("f1", "src", "proc", "flows_to", { label: "原始事件", order: 1 }), relation("f2", "proc", "store", "writes", { label: "写入", order: 2 })],
      { stages: [{ id: "s1", label: "采集", order: 0, evidence: evidence("s1") }, { id: "s2", label: "处理", order: 1, evidence: evidence("s2") }, { id: "s3", label: "存储", order: 2, evidence: evidence("s3") }] }),
    lifecycle: diagram("lifecycle",
      [node("created", "创建", "state"), node("paid", "已支付", "state"), node("shipped", "已发货", "state"), node("done", "已完成", "state"), node("cancelled", "已取消", "event")],
      [relation("t1", "created", "paid", "transitions", { label: "支付", order: 1 }), relation("t2", "paid", "shipped", "transitions", { label: "发货", order: 2 }), relation("t3", "shipped", "done", "transitions", { label: "签收", order: 3 }), relation("t4", "paid", "cancelled", "transitions", { label: "取消", order: 4, condition: "超时" })],
      { lanes: [{ id: "main", label: "阶段", evidence: evidence("created") }, { id: "terminal", label: "结果", evidence: evidence("done") }], states: [{ nodeId: "created", kind: "initial", evidence: evidence("created") }, { nodeId: "paid", kind: "normal", evidence: evidence("paid") }, { nodeId: "shipped", kind: "normal", evidence: evidence("shipped") }, { nodeId: "done", kind: "terminal", outcome: "success", evidence: evidence("done") }, { nodeId: "cancelled", kind: "terminal", outcome: "failure", evidence: evidence("cancelled") }], transitions: [{ relationId: "t1", event: "支付", evidence: evidence("t1") }, { relationId: "t2", event: "发货", evidence: evidence("t2") }, { relationId: "t3", event: "签收", evidence: evidence("t3") }, { relationId: "t4", event: "取消", condition: "超时", evidence: evidence("t4") }] })
  };
  const adapter = new ui.ArchifyAdapter(resolve("vendor/project-diagrams/archify"));
  const htmlByKind = {};
  for (const [kind, fixture] of Object.entries(fixtures)) {
    const document = await adapter.transform(fixture);
    const artifact = await adapter.render(document);
    assert.equal(artifact.format, "html");
    assert.ok(String(artifact.content).includes("<!DOCTYPE html>") || String(artifact.content).includes("<html"));
    assert.equal(/(?:src|href)=["']https?:/i.test(String(artifact.content)), false, `${kind}: the artifact must not reference remote resources`);
    htmlByKind[kind] = artifact.content;
    console.log(`rendered ${kind}: ${String(artifact.content).length} bytes`);
  }
  const summaries = Object.entries(fixtures).map(([kind, value]) => ({ id: value.id, title: value.title, kind, version: value.version, updatedAt: value.updatedAt, review: "draft" }));
  const baseData = () => ({
    overview: { name: "Dext", root: ".", objects: 0, accepted: 0, drafts: 0, needsVerification: 0, initialization: { status: "uninitialized", drafts: 0, intentGenerated: false, diagramsGenerated: 0 } },
    objects: [],
    architecture: {
      diagrams: summaries, selected: summaries[0], knowledgeUninitialized: true,
      engine: { id: "archify", version: adapter.version, available: true }, decisions: [],
      // Declared rules are user-authored text from .dext/architecture.json, so they are rendered
      // here exactly as the host passes them.
      rules: [{ id: "no-ui-db<script>", type: "deny", from: "ui", to: "db", reason: "UI writes through the API." }],
      violations: [{ ruleId: "no-ui-db<script>", nodeIds: ["ui", "db"], reason: "Denied architecture dependency." }]
    }
  });
  const artifacts = resolve(".tmp-tb/project-diagrams-ui");
  await mkdir(artifacts, { recursive: true });

  let panelPage = "";
  let probePage = "";
  server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(request.url?.startsWith("/probe") ? probePage : panelPage);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const loadPanel = async (page, data) => {
    const styleUrl = `${origin}/editorTabs.css`;
    panelPage = ui.renderEditorTabHtml(
      // VS Code allows one acquireVsCodeApi() per webview document and throws on a second call,
      // so the stub enforces the same rule: a page script that acquires it twice fails here.
      '<script>window.messages=[];window.__apiAcquired=0;window.acquireVsCodeApi=function(){if(window.__apiAcquired++)throw new Error("An instance of the VS Code API has already been acquired");return {postMessage:message=>messages.push(message)};};window.__fromFrame=[];window.addEventListener("message",function(event){var frame=document.querySelector("[data-diagram-frame]");if(frame&&event.source===frame.contentWindow)window.__fromFrame.push(event.data);});</script>'
      + ui.renderProjectPanel(page, data),
      styleUrl,
      origin,
      { embedFrames: true }
    );
    await send("Page.navigate", { url: `${origin}/?${Date.now()}` });
    for (let index = 0; index < 100; index++) {
      if (await evaluate('document.readyState === "complete" && !!document.querySelector(".project-panel")')) return;
      await sleep(30);
    }
    throw new Error("Project panel did not load");
  };
  const waitForFrameMessage = async (predicate, label) => {
    for (let index = 0; index < 200; index++) {
      if (await evaluate(`window.__fromFrame.some(function(message){ return ${predicate}; })`)) return;
      await sleep(50);
    }
    throw new Error(`Timeout waiting for iframe message: ${label}`);
  };
  const waitForHostMessage = async (predicate, label) => {
    for (let index = 0; index < 200; index++) {
      if (await evaluate(`window.messages.some(function(message){ return ${predicate}; })`)) return;
      await sleep(50);
    }
    throw new Error(`Timeout waiting for host message: ${label}`);
  };

  // 1. Uninitialized overview
  await loadPanel("overview", baseData());
  assert.equal(await evaluate('document.querySelector("[data-project-initialization-state]").getAttribute("data-project-initialization-state")'), "uninitialized");
  assert.equal(await evaluate('!!document.querySelector("[data-project-initialize]")'), true);
  assert.equal(await evaluate('!document.querySelector("[data-project-choose-roots]") && !/scan folder/i.test(document.body.textContent)'), true);

  // 2. Five kinds are listed, old renderer controls are gone
  await loadPanel("architecture", baseData());
  assert.equal(await evaluate('document.querySelectorAll("[data-diagram-select] option").length'), 5);
  for (const kind of ["Architecture", "Workflow", "Sequence", "Data flow", "Lifecycle"]) {
    assert.equal(await evaluate(`document.body.textContent.includes(${JSON.stringify(kind)})`), true, `missing ${kind}`);
  }
  assert.equal(await evaluate('document.body.textContent.includes("Use recommended") || document.body.textContent.includes("Fallback:") || !!document.querySelector("[data-project-adapter-select]")'), false);
  assert.equal(await evaluate('document.body.textContent.includes("Project knowledge is not initialized")'), true);

  // 2b. Declared rules render with their violations, escaped, and without claiming a baseline
  assert.equal(await evaluate('!!document.querySelector(".architecture-rules")'), true, "rules section");
  assert.equal(await evaluate('document.querySelectorAll(".architecture-rule").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll(".architecture-violations li").length'), 1);
  assert.equal(await evaluate('document.body.textContent.includes("Violations (1)")'), true);
  assert.equal(await evaluate('document.body.textContent.includes("New violations")'), false, "no baseline was supplied");
  assert.equal(await evaluate('document.querySelectorAll(".architecture-rules script").length'), 0, "rule ids are escaped");
  assert.equal(await evaluate('document.querySelector(".architecture-rule code").textContent'), "no-ui-db<script>");

  // 3. Rendered HTML bridge: fonts, explorer, export, version banner
  const postRendered = async (kind, options = {}) => {
    const value = fixtures[kind];
    await evaluate(`window.postMessage({type:"projectDiagramRendered",diagramId:${JSON.stringify(value.id)},requestedVersion:${options.requestedVersion ?? value.version},displayedVersion:${options.displayedVersion ?? value.version},usedLastGood:${Boolean(options.usedLastGood)},html:${JSON.stringify(htmlByKind[kind])},mapping:{reverseIds:{"n-1":"${value.nodes[0].id}"}},receipt:{status:"passed",issues:[]},updatedAt:Date.now()${options.error ? `,error:${JSON.stringify(options.error)}` : ""}},"*")`);
    await waitForFrameMessage('message && message.type === "dext-diagram-ready"', `ready for ${kind}`);
    const ready = await evaluate('window.__fromFrame.find(function(message){return message.type==="dext-diagram-ready";})');
    assert.equal(ready.archify, true, `${kind}: Archify global`);
    assert.equal(ready.fonts, true, `${kind}: bundled fonts`);
  };
  await postRendered("architecture");
  assert.equal(await evaluate('!document.querySelector("[data-diagram-frame]").hidden'), true);
  await evaluate('document.querySelector("[data-diagram-export-format]").value="svg";document.querySelector("[data-diagram-action=export]").click()');
  await waitForHostMessage('message.type === "projectDiagramExport" && message.format === "svg"', "SVG export");
  const svgExport = await evaluate('window.messages.find(function(message){return message.type==="projectDiagramExport"&&message.format==="svg";})');
  assert.ok(svgExport.content.trimStart().startsWith("<svg"), "native SVG serialization captured");
  assert.ok(svgExport.content.includes("@font-face"), "SVG export keeps bundled fonts");
  await evaluate('document.querySelector("[data-diagram-export-format]").value="html";document.querySelector("[data-diagram-action=export]").click()');
  await waitForHostMessage('message.type === "projectDiagramExport" && message.format === "html"', "HTML export");
  await postRendered("architecture", { usedLastGood: true, displayedVersion: 1, requestedVersion: 2, error: "layout failed" });
  await sleep(200);
  assert.equal(await evaluate('document.body.textContent.includes("v1") && document.body.textContent.includes("last successful result")'), true);
  await writeFile(join(artifacts, "architecture-viewer.png"), Buffer.from((await send("Page.captureScreenshot")).data, "base64"));

  // 4. Remaining kinds render natively
  for (const kind of ["workflow", "sequence", "data_flow", "lifecycle"]) await postRendered(kind);

  // 5. Empty state and no fake diagram
  const emptyData = baseData();
  emptyData.architecture = { diagrams: [], engine: { id: "archify", version: adapter.version, available: true } };
  await loadPanel("architecture", emptyData);
  assert.equal(await evaluate('!!document.querySelector("[data-diagram-empty]")'), true);
  assert.equal(await evaluate('document.body.textContent.includes("No diagram generated yet")'), true);
  assert.equal(await evaluate('!!document.querySelector("[data-diagram-frame]") && !document.querySelector("[data-diagram-frame]").hidden'), false);

  // 6. CSP contains the viewer sources required by the sandboxed artifact
  const csp = await evaluate('document.querySelector("meta[http-equiv=\\"Content-Security-Policy\\"]").content');
  assert.ok(csp.includes("frame-src 'self'"), `viewer CSP allows the sandboxed frame: ${csp}`);
  assert.ok(csp.includes("font-src data:"), `viewer CSP allows bundled fonts: ${csp}`);
  assert.ok(csp.includes("img-src data: blob:"), `viewer CSP allows serialized images: ${csp}`);

  // 7. Narrow window has no horizontal overflow
  await send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: false });
  await loadPanel("architecture", baseData());
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  await send("Emulation.clearDeviceMetricsOverride");

  // 8. Direct bridge interaction: search, zoom and reset inside the sandboxed viewer
  const bridge = ui.archifyViewerBridgeScript("probe-session", "dark");
  let probeHtml = htmlByKind.architecture.replace("<head>", `<head><script nonce="probe-nonce">${bridge}<\/script>`);
  probeHtml = probeHtml.replace(/<script(?![^>]*\bnonce=)/g, '<script nonce="probe-nonce"');
  probePage = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-probe-nonce'; frame-src 'self'; font-src data:; img-src data: blob:; connect-src 'none';">`
    + `</head><body style="margin:0">`
    + `<iframe id="probe" sandbox="allow-scripts" style="width:900px;height:700px" srcdoc="${probeHtml.replaceAll("&", "&amp;").replaceAll(String.fromCharCode(34), "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"></iframe>`
    + `<script nonce="probe-nonce">window.__probeMessages=[];window.addEventListener("message",function(event){if(event.source===document.getElementById("probe").contentWindow)window.__probeMessages.push(event.data);});`
    + `window.__probeSend=function(message){document.getElementById("probe").contentWindow.postMessage(Object.assign({__dext:"probe-session"},message),"*");};` + String.fromCharCode(60) + `/script></body></html>`;
  await send("Page.navigate", { url: `${origin}/probe?${Date.now()}` });
  for (let index = 0; index < 200; index++) {
    if (await evaluate('window.__probeMessages.some(function(message){return message.type==="dext-diagram-ready";})')) break;
    await sleep(50);
  }
  const probeReady = await evaluate('window.__probeMessages.find(function(message){return message.type==="dext-diagram-ready";})');
  assert.equal(probeReady.archify, true);
  assert.ok(probeReady.fontFaces > 0, "bundled JetBrains Mono faces are present in the sandboxed artifact");
  assert.equal(probeReady.explorerVisible, true, "native navigation stays available");
  await evaluate('window.__probeSend({type:"dext-diagram-command",command:"search",requestId:"s1"})');
  await evaluate('window.__probeSend({type:"dext-diagram-command",command:"zoom-in",requestId:"z1"})');
  await evaluate('window.__probeSend({type:"dext-diagram-command",command:"zoom-in",requestId:"z2"})');
  for (let index = 0; index < 100; index++) {
    if (await evaluate('window.__probeMessages.some(function(message){return message.requestId==="z2";})')) break;
    await sleep(50);
  }
  const searchResult = await evaluate('window.__probeMessages.find(function(message){return message.requestId==="s1";})');
  const zoomResult = await evaluate('window.__probeMessages.find(function(message){return message.requestId==="z2";})');
  assert.equal(searchResult.searchOpen, true, "native finder opens");
  assert.notEqual(zoomResult.zoom, probeReady.zoom, "native zoom changes scale");
  await evaluate('window.__probeSend({type:"dext-diagram-command",command:"reset",requestId:"z3"})');
  for (let index = 0; index < 100; index++) {
    if (await evaluate('window.__probeMessages.some(function(message){return message.requestId==="z3";})')) break;
    await sleep(50);
  }
  const resetResult = await evaluate('window.__probeMessages.find(function(message){return message.requestId==="z3";})');
  assert.equal(resetResult.zoom, probeReady.zoom, "native reset restores the initial scale");
  await writeFile(join(artifacts, "native-viewer.png"), Buffer.from((await send("Page.captureScreenshot")).data, "base64"));

  console.log("PASS: five native Archify diagram kinds under the webview CSP; uninitialized/empty states; diagram selection; native fonts, finder, zoom and reset; HTML/SVG export bridge; last-good version labelling; narrow layout. Screenshots: .tmp-tb/project-diagrams-ui");
} finally {
  server?.close();
  try { await shutdown?.(); } catch {}
  socket?.close(); browser.kill();
  await sleep(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile cleanup: ${error.message}`));
}
