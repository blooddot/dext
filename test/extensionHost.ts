import assert from "node:assert/strict";
import * as vscode from "vscode";
import { DextApplication } from "../src/application.js";
import { openWorkspaceFileReference } from "../src/vscodeContextHost.js";
import { clipboardFileReferences } from "../src/vscodeClipboardFiles.js";
import { selectionAttachment, type SelectionTarget } from "../src/vscodeAttachments.js";
import { DextCompletionHost } from "../src/vscodeCompletionHost.js";
import { normalizeCompletionSettings } from "../src/core/completionProvider.js";
import { CompletionMemory, CompletionMemoryEpochs } from "../src/core/completionMemory.js";
import { fingerprint } from "../src/core/completionContext.js";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { DextCompletionContext } from "../src/vscodeCompletionContext.js";
import type * as Esbuild from "esbuild";
import { DextApiDefinitionProvider } from "../src/vscodeApiDefinitions.js";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("blooddot.dext");
  assert.ok(extension, "Dext extension is discoverable.");
  await extension.activate();
  assert.equal(extension.isActive, true, "Dext extension activates.");
  await monacoWebviewHostTest(extension.extensionUri);

  assert.deepEqual(vscode.workspace.getConfiguration("dext").inspect<string[]>("agentCli")?.defaultValue, ["codex", "claude", "deepseek-harness"]);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("dext.configureAgent"));
  for (const command of ["dext.loginCompletionChatGPT", "dext.logoutCompletionChatGPT", "dext.triggerChatGPTCompletion"]) assert.ok(!commands.includes(command), "Retired Tab commands must not be registered.");
  assert.ok(commands.includes("dext.focus"), "Focus command is registered.");
  assert.ok(commands.includes("dext.reloadMethods"), "Reload command is registered.");
  assert.ok(commands.includes("dext.openHistory"), "History command is registered.");
  assert.ok(commands.includes("dext.history.renameTurn"), "Turn rename command is registered.");
  assert.ok(commands.includes("dext.history.copyTurn"), "Turn copy command is registered.");
  assert.ok(commands.includes("dext.history.retryTurn"), "Turn retry command is registered.");
  assert.ok(commands.includes("dext.history.deleteTurn"), "Turn delete command is registered.");
  assert.ok(commands.includes("dext.openWorkspaceTrust"), "Workspace Trust command is registered.");
  assert.ok(commands.includes("dext.workspaceTrustedStatus"), "Trusted workspace title action is registered.");
  assert.ok(commands.includes("dext.workspaceUntrustedStatus"), "Untrusted workspace title action is registered.");
  assert.ok(commands.includes("dext.triggerSuggest"), "Suggest command is registered.");
  assert.ok(commands.includes("dext.triggerParameterHints"), "Parameter hints command is registered.");
  assert.ok(commands.includes("dext.addSelectionToChat"), "Selection attachment command is registered.");
  assert.ok(commands.includes("dext.copySelectionWithContext"), "Context copy command is registered.");
  assert.ok(commands.includes("dext.addFileToChat"), "File attachment command is registered.");
  assert.ok(commands.includes("dext.setMcpAccessToken"), "Set MCP access token command is registered.");
  assert.ok(commands.includes("dext.clearMcpAccessToken"), "Clear MCP access token command is registered.");
  assert.ok(commands.includes("dext.clearCompletionMemory"), "Completion memory clearing is registered.");
  assert.ok(commands.includes("dext.evaluateCompletion"), "Profile completion evaluation is registered.");
  assert.ok(commands.includes("dext.verifyMcpServer"), "Verify MCP server command is registered.");
  assert.equal(
    vscode.workspace.getConfiguration("dext").get("captureSelectionOnCopy"),
    true,
    "Selection capture is enabled by default."
  );

  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "Extension Host test opens a workspace folder.");
  const file = vscode.Uri.joinPath(folder.uri, "package.json");
  const originalClipboard = await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText("__dext_clipboard_probe__");
  const clipboardBaseline = await vscode.env.clipboard.readText() === "__dext_clipboard_probe__";
  if (!clipboardBaseline) {
    console.warn("VS Code Extension Host clipboard baseline is unavailable; OS clipboard assertion is skipped.");
  }
  await vscode.env.clipboard.writeText(originalClipboard);
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  const copiedText = document.getText(new vscode.Range(0, 0, 0, 1));
  editor.selection = new vscode.Selection(0, 0, 0, 1);
  assert.equal(vscode.window.activeTextEditor, editor, "The source editor is active before context copy.");
  assert.equal(editor.selection.isEmpty, false, "The context-copy selection is nonempty.");
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", file);
  assert.ok(!lenses?.some((lens) => lens.command?.command === "dext.addSelectionToChat"), "Selecting code does not insert a Dext CodeLens row.");
  const selectionHovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", file, editor.selection.active);
  const selectionAction = selectionHovers?.flatMap((hover) => hover.contents)
    .find((content): content is vscode.MarkdownString => typeof content !== "string" && "value" in content && content.value.includes("command:dext.addSelectionToChat?"));
  assert.ok(selectionAction, "Selected code exposes Add to Dext in an overlay hover at the caret.");
  assert.deepEqual(selectionAction.isTrusted, { enabledCommands: ["dext.addSelectionToChat"] });
  const args = /command:dext.addSelectionToChat\?([^\s]+)/.exec(selectionAction.value)?.[1];
  assert.ok(args, "The hover link includes the captured selection.");
  const target = (JSON.parse(decodeURIComponent(args)) as SelectionTarget[])[0]!;
  assert.equal(target.uri, file.toString(), "The selection action captures the original file.");
  editor.selection = new vscode.Selection(1, 0, 1, 0);
  const selectedSnapshot = await selectionAttachment(target);
  assert.equal(selectedSnapshot.text, copiedText, "Clicking the action uses the captured selection even after the caret moves.");
  const clearedHovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", file, editor.selection.active);
  assert.ok(!clearedHovers?.flatMap((hover) => hover.contents).some((content) =>
    typeof content !== "string" && "value" in content && content.value.includes("command:dext.addSelectionToChat?")), "Clearing the selection removes the hover action.");
  editor.selection = new vscode.Selection(0, 0, 0, 1);
  try {
    await vscode.commands.executeCommand("copyFilePath", file);
    if (clipboardBaseline) {
      const paths = await vscode.env.clipboard.readText();
      assert.deepEqual(await clipboardFileReferences(paths), [
        { expression: "@package.json", payload: "package.json" }
      ], "VS Code Copy Path resolves to the original workspace file reference.");
    }
    const submittedText = await vscode.commands.executeCommand<string>("dext.copySelectionWithContext");
    assert.equal(submittedText, copiedText, "Context copy submits the exact selection text.");
    if (clipboardBaseline) {
      assert.equal(await vscode.env.clipboard.readText(), copiedText, "Context copy writes exact selection text.");
    }
  } finally {
    await vscode.env.clipboard.writeText(originalClipboard);
  }

  await vscode.commands.executeCommand("dext.addSelectionToChat");
  editor.selection = new vscode.Selection(1, 0, 1, 0);
  await vscode.commands.executeCommand("dext.addSelectionToChat", target);
  await vscode.commands.executeCommand("dext.addFileToChat", file);
  await vscode.commands.executeCommand("dext.addFileToChat", folder.uri);

  const app = new DextApplication();
  await app.reload();
  const response = await app.executeInput('ask(input=f"Explain {ref.file(\'package.json#L1,1-L1,2\')}")');
  const snapshot = response.executions[0];
  assert.equal(snapshot?.result.kind, "ask", "An inline file reference resolves for ask.");
  await openWorkspaceFileReference("package.json#L1,1-L1,2");
  assert.equal(
    vscode.window.activeTextEditor?.selection.isEqual(new vscode.Selection(0, 0, 0, 1)),
    true,
    "Opening a file reference selects its exact range."
  );
  await assert.rejects(
    openWorkspaceFileReference("../outside.txt"),
    /inside the current workspace/,
    "Opening a file reference rejects workspace traversal."
  );

  const dxFile = vscode.Uri.joinPath(folder.uri, "test", "fixtures", "language.dx");
  const dxDocument = await vscode.workspace.openTextDocument(dxFile);
  assert.equal(dxDocument.languageId, "dext-api", "A .dx file activates the Dext language.");
  await vscode.window.showTextDocument(dxDocument);
  const methodStart = dxDocument.getText().indexOf("ask");
  assert.ok(methodStart >= 0, "The Dext language fixture contains a built-in API call.");
  const completionPosition = dxDocument.positionAt(methodStart + "a".length);
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    dxDocument.uri,
    completionPosition,
    undefined
  );
  assert.ok(
    completions.items.some((item) => item.label === "ask"),
    "A .dx file receives API completions from the registered VS Code provider."
  );
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    dxDocument.uri,
    dxDocument.positionAt(methodStart + 1)
  );
  assert.ok(hovers.length > 0, "A .dx API call receives hover type information.");
  const targetValue = dxDocument.getText().indexOf("input=input", methodStart);
  const signatures = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    "vscode.executeSignatureHelpProvider",
    dxDocument.uri,
    dxDocument.positionAt(targetValue + "input=".length),
    "("
  );
  assert.ok(signatures.signatures.length > 0, "A .dx API call receives parameter hints.");
  assert.equal(signatures.activeParameter, 0, "Parameter hints select the first API parameter.");

  await vscode.commands.executeCommand("dext.triggerSuggest");
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), dxDocument.uri.toString(), "Suggest keeps focus in the .dx editor.");
  await vscode.commands.executeCommand("dext.triggerParameterHints");
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), dxDocument.uri.toString(), "Parameter hints keep focus in the .dx editor.");
  const activeGroup = vscode.window.tabGroups.activeTabGroup;
  const tabCount = activeGroup.tabs.length;
  await vscode.commands.executeCommand("dext.openHistory");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const historyTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!historyTab) throw new Error("Dext History did not open an active tab.");
  assert.equal(historyTab.label, "Dext History", "History tab has a clear output title.");
  assert.ok(historyTab.input instanceof vscode.TabInputWebview, "History opens as an independent webview tab.");
  if (historyTab.input instanceof vscode.TabInputWebview) {
    assert.ok(historyTab.input.viewType.endsWith("dext.history"), "History uses the Dext History webview.");
  }
  assert.equal(vscode.window.tabGroups.activeTabGroup, activeGroup, "History stays in the same editor group.");
  assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.length, tabCount + 1, "History adds one tab beside the current file.");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), dxDocument.uri.toString(), "Closing History returns to the original text editor.");
  assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.length, tabCount, "Closing History leaves the original tab intact.");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await vscode.commands.executeCommand("dext.reloadMethods");
  await vscode.commands.executeCommand("dext.focus");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await verifyCompletionEditing(folder);
  await verifyEditorTabs();
  await verifyCompletionMemoryWindows(extension.extensionPath, folder);
  if (process.env.DEXT_COMPLETION_PERFORMANCE === "1") await verifyCompletionPerformance(extension.extensionPath, folder);
}

/** Run the production component with real VS Code resource URLs, CSP and workers. */
async function monacoWebviewHostTest(extensionUri: vscode.Uri): Promise<void> {
  const require = createRequire(join(extensionUri.fsPath, "package.json"));
  const esbuild = require("esbuild") as typeof Esbuild;
  const directory = await mkdtemp(join(tmpdir(), "dext-monaco-host-"));
  const panel = vscode.window.createWebviewPanel("dext.monaco-test", "Dext editor verification", vscode.ViewColumn.Active, {
    enableScripts: true, localResourceRoots: [vscode.Uri.file(directory), vscode.Uri.joinPath(extensionUri, "dist")]
  });
  try {
    await esbuild.build({ absWorkingDir: extensionUri.fsPath, stdin: { resolveDir: extensionUri.fsPath, contents: `
      import { DextCodeEditor } from './src/webview/codeEditor.ts';
      import { monaco } from './src/webview/monacoEnvironment.ts';
      import './media/styles.css';
      const vscode=acquireVsCodeApi();
      const check=(condition,label)=>{if(!condition)throw new Error(label);};
      window.addEventListener('error',event=>vscode.postMessage({error:event.message}));
      window.addEventListener('unhandledrejection',event=>vscode.postMessage({error:String(event.reason)}));
      window.addEventListener('securitypolicyviolation',event=>vscode.postMessage({error:'CSP: '+event.violatedDirective+' '+event.blockedURI}));
      (async()=>{
        let workerReplies=0;
        const editor=new DextCodeEditor({parent:document.getElementById('editor'),
          broker:{request:async()=>({diagnostics:[],completions:[],inputKind:'workflow'}),definition:async()=>undefined},
          clipboard:{write:async()=>true,read:async()=>({text:'',contextAttached:false})},files:{search:async()=>[]},resolveDroppedFiles:async()=>['@scripts/','@src/dropped.ts'],
          onRun(){},onOpenReference(){},onDiagnosticsChanged(){},onInputKindChanged(){},onError(error){throw error;}});
        const getWorker=globalThis.MonacoEnvironment.getWorker;
        globalThis.MonacoEnvironment.getWorker=async(...args)=>{const worker=await getWorker(...args);worker.addEventListener('message',()=>workerReplies++);return worker;};
        const source='agent(input="@src/a.ts#L1,1-L2,2")';editor.setValue(source);
        await new Promise(r=>setTimeout(r,200));
        check(editor.source===source,'source round trip');
        check(document.querySelectorAll('.dext-ref-chip').length===1,'reference rendered');
        editor.removeFileReference('src/a.ts#L1,1-L2,2');editor.view.trigger('test','undo',{});
        check(editor.source===source,'reference undo');
        const previousClipboard=await Promise.all((await navigator.clipboard.read()).map(async item=>new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type=>[type,await item.getType(type)]))))));
        let pastedImage;
        const imagePaste=event=>{const item=[...event.clipboardData.items].find(item=>item.kind==='file'&&item.type.startsWith('image/'));if(item){pastedImage=item.getAsFile();event.preventDefault();event.stopPropagation();}};
        document.body.addEventListener('paste',imagePaste,true);
        try {
          editor.setMode("chat");editor.setValue('');
          await navigator.clipboard.writeText('@src/pasted.ts');
          editor.focus();document.execCommand('paste');
          await new Promise(r=>setTimeout(r,200));
          check(editor.source==='@src/pasted.ts','Webview chat paste keeps source: '+JSON.stringify(editor.source));
          check(document.querySelectorAll('.dext-ref-chip').length===1,'Webview chat paste renders reference');
          editor.view.trigger('test','undo',{});check(editor.source==='','Webview chat paste undo');
          editor.view.trigger('test','redo',{});check(editor.source==='@src/pasted.ts','Webview chat paste redo');
          const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;
          const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
          await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
          editor.focus();document.execCommand('paste');
          await new Promise(r=>setTimeout(r,200));
          check(pastedImage?.type==='image/png'&&pastedImage.size>0,'Webview image paste reaches the attachment handler');
          check(editor.source==='@src/pasted.ts','image paste does not insert clipboard fallback text');
          editor.insertFileReferences(['@.dext-global/attachments/pasted.png']);
          await new Promise(r=>setTimeout(r,100));
          check(document.querySelectorAll('.dext-ref-chip').length===2,'attachment response renders an image reference');
          editor.setValue('');
          const transfer=new DataTransfer();transfer.setData('application/vnd.code.uri-list','file:///C:/project/scripts');
          const input=document.querySelector('#editor textarea'),box=input.getBoundingClientRect();
          input.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,shiftKey:true,dataTransfer:transfer,clientX:box.left+2,clientY:box.top+2}));
          await new Promise(r=>setTimeout(r,200));
          check(editor.source==='@scripts/ @src/dropped.ts ','Webview Shift-drop keeps full paths');
          check(document.querySelectorAll('.dext-ref-chip').length===2,'Webview Shift-drop renders root directory and file references');
        } finally {
          document.body.removeEventListener('paste',imagePaste,true);
          if(previousClipboard.length)await navigator.clipboard.write(previousClipboard);else await navigator.clipboard.writeText('');
        }
        editor.setMode("code");
        editor.setValue('alphabet alphabet\\nalp');editor.view.updateOptions({wordBasedSuggestions:'currentDocument'});editor.triggerSuggest();
        for(let i=0;i<60&&!workerReplies;i++)await new Promise(r=>setTimeout(r,100));
        check(workerReplies>0,'bundled worker replies over real Webview resource URLs');
        monaco.editor.setModelMarkers(editor.view.getModel(),'host-test',[{severity:monaco.MarkerSeverity.Error,message:'Host diagnostic',startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:4}]);
        await new Promise(r=>setTimeout(r,200));
        const squiggle=document.querySelector('.monaco-editor .squiggly-error');
        check(squiggle&&getComputedStyle(squiggle).backgroundImage.includes('data:image/svg+xml'),'native diagnostic image renders under Webview CSP');
        editor.destroy();vscode.postMessage({passed:true,workerReplies});
      })().catch(error=>vscode.postMessage({error:String(error.stack||error)}));
    ` }, bundle: true, outdir: directory, entryNames: "check", format: "iife", platform: "browser", loader: { ".ttf": "file" }, logLevel: "silent" });
    const asset = (path: vscode.Uri) => panel.webview.asWebviewUri(path).toString();
    const result = new Promise<{ passed?: boolean; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { listener.dispose(); reject(new Error("Monaco Webview verification timed out")); }, 30000);
      const listener = panel.webview.onDidReceiveMessage((message: { passed?: boolean; error?: string }) => {
        if (message.passed || message.error) { clearTimeout(timer); listener.dispose(); resolve(message); }
      });
    });
    panel.webview.html = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} https: data:; script-src 'nonce-monaco-test'; style-src ${panel.webview.cspSource} 'unsafe-inline'; font-src ${panel.webview.cspSource}; connect-src ${panel.webview.cspSource}; worker-src blob:;">
      <meta name="dext-editor-worker" content="${asset(vscode.Uri.joinPath(extensionUri, "dist", "webview", "editor.worker.js"))}">
      <link rel="stylesheet" href="${asset(vscode.Uri.file(join(directory, "check.css")))}"></head>
      <body><div id="editor" class="code-editor" style="width:320px;height:280px"></div><script nonce="monaco-test" src="${asset(vscode.Uri.file(join(directory, "check.js")))}"></script></body></html>`;
    const outcome = await result;
    assert.equal(outcome.error, undefined, outcome.error);
    assert.equal(outcome.passed, true, "Monaco runs inside an actual VS Code Webview");
    panel.dispose();
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const provider = new DextApiDefinitionProvider(() => undefined);
      const source = "node.url.parse(url=\"https://example.com\")";
      const target = (await provider.resolve(source, 10, vscode.Uri.parse("dext-input:/composer.dx"), cancellation.token))?.[0];
      assert.ok(target, "Input built-in definition resolves");
      const editor = await vscode.window.showTextDocument(target.targetUri, { selection: target.targetSelectionRange ?? target.targetRange });
      assert.equal(editor.document.uri.scheme, "dext-builtins");
      assert.equal(editor.document.getText(editor.selection), "parse");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    } finally { cancellation.dispose(); }
  } finally {
    panel.dispose();
    assert.ok(directory.startsWith(join(tmpdir(), "dext-monaco-host-")));
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyCompletionPerformance(extensionPath: string, folder: vscode.WorkspaceFolder): Promise<void> {
  const revision = "53ccfd28e6213ca967b12023c7d6d7fac06a1048";
  const require = createRequire(join(extensionPath, "package.json"));
  const esbuild = require("esbuild") as typeof Esbuild;
  const directory = await mkdtemp(join(tmpdir(), "dext-completion-bench-"));
  const compiled = await esbuild.build({ entryPoints: ["src/vscodeCompletionHost.ts"], absWorkingDir: extensionPath,
    bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"], plugins: [{ name: "baseline", setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/].*\.ts$/ }, (args) => ({
        contents: execFileSync("git", ["show", `${revision}:${relative(extensionPath, args.path).replaceAll("\\", "/")}`], { cwd: extensionPath, encoding: "utf8" }), loader: "ts"
      }));
    } }] });
  const modulePath = join(directory, "baseline.cjs"); await writeFile(modulePath, compiled.outputFiles[0]!.text);
  const BaselineHost = (require(modulePath) as { DextCompletionHost: typeof DextCompletionHost }).DextCompletionHost;
  const oldFetch = globalThis.fetch;
  const docs: vscode.TextDocument[] = [];
  const calls = { baseline: 0, current: 0 }; let active: "baseline" | "current" = "current";
  globalThis.fetch = async () => { calls[active]++; return new Response(JSON.stringify({ choices: [{ text: "items.length" }] })); };
  const config = normalizeCompletionSettings({ enabled: true, endpoint: "https://offline.invalid", model: "fixture", debounceMs: 1, ignoreGitignore: false });
  const retrieval = new DextCompletionContext(() => config);
  const providers = { baseline: new BaselineHost({ settings: () => config, apiKey: async () => undefined }),
    current: new DextCompletionHost({ settings: () => config, apiKey: async () => undefined, context: retrieval }) };
  const token = new vscode.CancellationTokenSource();
  try {
    const lines = Array.from({ length: 220 }, (_, i) => `const value${i} = `).join("\n");
    for (const [i, content] of [lines, "// preceding\n".repeat(100000) + lines, lines].entries()) {
      const uri = vscode.Uri.joinPath(folder.uri, "test", "fixtures", `completion-performance-${Date.now()}-${i}.ts`);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      docs.push(await vscode.workspace.openTextDocument(uri));
    }
    for (const doc of docs) await eventually(async () => retrieval.allowed(doc.uri), "benchmark ignore rules");
    const invoke = async (version: "baseline" | "current", doc: vscode.TextDocument, line: number, character?: number) => {
      active = version;
      return providers[version].provideInlineCompletionItems(doc, new vscode.Position(line, character ?? doc.lineAt(line).text.length),
        { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined }, token.token);
    };
    for (const scenario of ["cache", "first", "continuous", "large-file", "file-switch"]) {
      for (const provider of Object.values(providers)) provider.refresh();
      for (const doc of docs) await eventually(async () => retrieval.allowed(doc.uri), "benchmark warm rules");
      const samples = { baseline: [] as number[], current: [] as number[] };
      const returned = { baseline: 0, current: 0 };
      calls.baseline = 0; calls.current = 0;
      if (scenario === "cache") for (const version of ["baseline", "current"] as const) await invoke(version, docs[0]!, 0);
      for (let i = 0; i < 200; i++) for (const version of (i % 2 ? ["baseline", "current"] : ["current", "baseline"]) as ("baseline" | "current")[]) {
        const doc = docs[scenario === "large-file" ? 1 : scenario === "file-switch" && i % 2 ? 2 : 0]!;
        const line = scenario === "cache" ? 0 : (scenario === "large-file" ? 100000 : 0) + i;
        const at = performance.now();
        const result = scenario === "continuous"
          ? (await Promise.all([invoke(version, doc, line), invoke(version, doc, line)]))[1]
          : await invoke(version, doc, line);
        samples[version].push(performance.now() - at); returned[version] += result.length;
      }
      for (const version of ["baseline", "current"] as const) {
        const values = samples[version].sort((a, b) => a - b);
        console.log(JSON.stringify({ completionBenchmark: scenario, version, revision: version === "baseline" ? revision : undefined,
          samples: values.length, p50Ms: values[99], p95Ms: values[189], modelCalls: calls[version], returned: returned[version],
          scope: "actual VS Code documents and provider; fixed HTTP responses; overlapping calls for continuous scenario; excludes screen paint and real model latency" }));
      }
    }
  } finally {
    globalThis.fetch = oldFetch; token.dispose(); providers.baseline.dispose(); providers.current.dispose(); retrieval.dispose();
    for (const doc of docs) await vscode.workspace.fs.delete(doc.uri);
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()), "Unexpected benchmark directory.");
    await rm(directory, { recursive: true, force: true });
  }
}

async function eventually(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out: ${description}`);
}

export async function completionMemoryPeer(store: vscode.Memento, directory: string, restore: boolean): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0]!.uri.toString();
  const key = fingerprint("integration-memory-counter");
  const epochs = new CompletionMemoryEpochs(join(directory, "epochs"));
  const memory = new CompletionMemory(store, "workspace", () => 1000, epochs);
  try {
    await eventually(async () => { await epochs.prepare(root); return epochs.current(root) !== undefined; }, "peer epoch preparation");
    if (restore) {
      assert.equal(memory.bucket(root, key).retained, 1, `A new VS Code process restores its persisted current-generation statistic (${store.keys().filter((key) => key.startsWith("dext.completion.memory.")).length} memory keys).`);
      await memory.clear(root);
      assert.equal(memory.bucket(root, key).retained, 0);
      return;
    }
    memory.record(root, key, "retained"); await memory.flush();
    const stale = store.keys().filter((key) => key.startsWith("dext.completion.memory.")).map((key) => [key, structuredClone(store.get(key))] as const);
    memory.record(root, key, "retained");
    const before = epochs.current(root);
    await writeFile(join(directory, "ready"), "ready");
    await eventually(async () => { await epochs.prepare(root); return epochs.current(root) !== undefined && epochs.current(root) !== before; }, "clear from the other VS Code window");
    assert.equal(memory.bucket(root, key).retained, 0, "A live peer discards dirty pre-clear memory.");
    await memory.flush();
    for (const [key, value] of stale) await store.update(key, value);
    const restored = new CompletionMemory(store, "workspace", () => 1000, epochs);
    assert.equal(restored.bucket(root, key).retained, 0, "Rewriting old Memento values cannot restore cleared experience.");
    restored.record(root, key, "retained"); await restored.flush();
    assert.equal(restored.bucket(root, key).retained, 1, "The peer retains its new-generation sample before shutdown.");
    restored.dispose();
  } finally { memory.dispose(); epochs.dispose(); }
}

async function verifyCompletionMemoryWindows(extensionPath: string, folder: vscode.WorkspaceFolder): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "dext-memory-host-"));
  const root = folder.uri.toString();
  const epochs = new CompletionMemoryEpochs(join(directory, "epochs"));
  const memory = new CompletionMemory(undefined, "workspace", () => 1000, epochs);
  const fixture = join(directory, "fixture"); await mkdir(fixture);
  await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "completion-memory-test", publisher: "dext-test", version: "1.0.0",
    engines: { vscode: "^1.105.0" }, activationEvents: ["onStartupFinished"], main: "./main.cjs" }));
  // Extension Test mode deliberately uses volatile storage. A temporary
  // development extension exercises the real Memento/SQLite shutdown path.
  await writeFile(join(fixture, "main.cjs"), `
    const vscode = require('vscode');
    const fs = require('node:fs/promises');
    exports.activate = async (context) => {
      const phase = process.env.DEXT_COMPLETION_MEMORY_PHASE;
      const directory = ${JSON.stringify(directory)};
      try {
        await require(${JSON.stringify(join(extensionPath, "dist", "extensionHostTest.js"))}).completionMemoryPeer(context.workspaceState, directory, phase === 'restore');
        await fs.writeFile(require('node:path').join(directory, phase + '.passed'), 'passed');
      } catch (error) {
        await fs.writeFile(require('node:path').join(directory, phase + '.failed'), String(error.stack || error));
      } finally { setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 100); }
    };`);
  const launch = (phase: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DEXT_COMPLETION_MEMORY_PEER: directory, DEXT_COMPLETION_MEMORY_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.VSCODE_IPC_HOOK_CLI;
    const child = spawn(process.execPath, [folder.uri.fsPath, "--new-window", "--disable-extensions", "--disable-workspace-trust",
      "--skip-welcome", "--skip-release-notes", "--no-sandbox", "--disable-updates",
      `--user-data-dir=${join(directory, "profile")}`, `--extensions-dir=${join(directory, "extensions")}`,
      `--extensionDevelopmentPath=${fixture}`], {
      windowsHide: true, env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let log = "";
    child.stdout.on("data", (data: Buffer) => { log = (log + data.toString()).slice(-16000); });
    child.stderr.on("data", (data: Buffer) => { log = (log + data.toString()).slice(-16000); });
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("Memory integration peer timed out.")); }, 60_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();
        if (code === 0) resolve(); else reject(new Error(`Memory integration peer exited ${code}: ${log}`)); });
    });
    // The parent also waits for the ready marker, so observe early process failures.
    void result.catch(() => undefined);
    return { child, result };
  };
  let peer: ReturnType<typeof launch> | undefined;
  try {
    await eventually(async () => { await epochs.prepare(root); return epochs.current(root) !== undefined; }, "coordinator epoch preparation");
    peer = launch("observe");
    await Promise.race([eventually(async () => { try { return await readFile(join(directory, "ready"), "utf8") === "ready"; } catch { return false; } }, "peer ready"),
      peer.result.then(() => { throw new Error("Peer exited before the cross-window clear."); })]);
    await memory.clear(root); await peer.result;
    const verifyPhase = async (phase: string) => {
      const failure = await readFile(join(directory, phase + ".failed"), "utf8").catch(() => undefined);
      assert.equal(failure, undefined, failure);
      assert.equal(await readFile(join(directory, phase + ".passed"), "utf8"), "passed");
    };
    await verifyPhase("observe");
    peer = launch("restore"); await peer.result; await verifyPhase("restore");
    console.log("Completion memory: two live VS Code hosts, stale Memento replay, and process restart passed.");
  } finally {
    peer?.child.kill(); memory.dispose(); epochs.dispose();
    assert.ok(dirname(resolve(directory)) === resolve(tmpdir()) && directory.includes("dext-memory-host-"), "Unexpected integration cleanup path.");
    await rm(directory, { recursive: true, force: true, maxRetries: 0 }).catch(() => {
      console.warn(`The test profile remains locked by VS Code: ${directory}`);
    });
  }
}

/**
 * Verifies the migrated editor tabs against a real VS Code window: each directory opens as its own
 * webview tab, reopening reuses the page, closing releases it, and the Review UI ships in the bundle.
 */
async function verifyEditorTabs(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["dext.openProject", "dext.viewApis", "dext.viewResources", "dext.editResource"]) {
    assert.ok(commands.includes(command), `${command} is registered.`);
  }
  const group = vscode.window.tabGroups.activeTabGroup;
  const before = group.tabs.length;
  const openAndAwait = async (command: string, viewTypeSuffix: string): Promise<vscode.Tab> => {
    await vscode.commands.executeCommand(command);
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewTypeSuffix)) return tab;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${command} did not open a ${viewTypeSuffix} webview tab.`);
  };
  const apis = await openAndAwait("dext.viewApis", "dext.api");
  assert.equal(apis.label, "Dext APIs", "The API directory opens as its own tab.");
  const apiCount = vscode.window.tabGroups.activeTabGroup.tabs.length;
  // Reopening the same target must reveal the existing page instead of creating a second one.
  await vscode.commands.executeCommand("dext.viewApis");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.length, apiCount, "Reopening APIs reuses the open page.");
  await openAndAwait("dext.viewResources", "dext.globalResources");
  await openAndAwait("dext.openProject", "dext.project");
  const projectTab = vscode.window.tabGroups.activeTabGroup.activeTab!;
  assert.equal(projectTab.label, "Dext Project", "The Project tab has a clear title.");
  assert.equal(
    vscode.window.tabGroups.activeTabGroup.tabs.length,
    before + 3,
    "Project, APIs, and Global Resources each contribute exactly one tab."
  );
  for (let index = 0; index < 3; index++) {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.length, before, "Closing the migrated tabs releases them.");
  // The packaged conversation bundle must carry the Review UI, and Assets cannot be silently missing.
  const bundle = await readFile(join(vscode.extensions.getExtension("blooddot.dext")!.extensionPath, "dist", "webview", "main.js"), "utf8");
  for (const marker of ["data-turn-review", "data-plan-review", "data-adopt-suggestion", "adoptKnowledgeSuggestion"]) {
    assert.ok(bundle.includes(marker), `The packaged conversation bundle includes '${marker}'.`);
  }
  console.log("Editor tabs: Project, APIs, and Global Resources open, reuse, and close in a live VS Code window.");
}

async function verifyCompletionEditing(folder: vscode.WorkspaceFolder): Promise<void> {  const name = `completion-host-${Date.now()}.ts`;
  const uri = vscode.Uri.joinPath(folder.uri, "test", "fixtures", name);
  const before = 'const userName = "A";\nconsole.log(usName);';
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(before));
  const settings = normalizeCompletionSettings({ enabled: true, endpoint: "https://completion-fixture.invalid", model: "fixture", ignoreGitignore: false, debounceMs: 1, adaptation: "session" });
  const host = new DextCompletionHost({ settings: () => settings, apiKey: async () => undefined,
    fetch: async () => new Response(JSON.stringify({ choices: [{ text: "erName" }] }), { headers: { "content-type": "application/json" } }) });
  let accepted = 0;
  const acceptance = vscode.commands.registerCommand("dext.testCompletionAccepted", (id: string) => { accepted++; host.accept(id); });
  const provider = vscode.languages.registerInlineCompletionItemProvider({ pattern: new vscode.RelativePattern(folder, `test/fixtures/${name}`) }, {
    provideInlineCompletionItems: async (document, position, context, token) => {
      const items = await host.provideInlineCompletionItems(document, position, context, token);
      for (const item of items) if (item.command) item.command.command = "dext.testCompletionAccepted";
      return items;
    }
  });
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    const position = document.positionAt(before.indexOf("usName") + 2);
    editor.selection = new vscode.Selection(position, position);
    await vscode.commands.executeCommand("hideSuggestWidget");
    await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vscode.commands.executeCommand("editor.action.inlineSuggest.commit");
    assert.equal(document.getText(), before.replace("usName", "userName"), "Inline accept replaces a same-line identifier tail exactly once.");
    assert.equal(accepted, 1, "The acceptance command runs only after the editor applies the suggestion.");
    await vscode.commands.executeCommand("undo");
    assert.equal(document.getText(), before, "Undo restores the original identifier including its existing tail.");
    host.refresh();
    await editor.edit((edit) => edit.insert(position, "x"));
    assert.equal(document.getText(), before.replace("usName", "usxName"), "Subsequent edits do not apply the old completion.");
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    } finally {
      provider.dispose(); acceptance.dispose(); host.dispose();
    await vscode.workspace.fs.delete(uri);
  }
}

