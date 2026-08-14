import assert from "node:assert/strict";
import * as vscode from "vscode";
import { DextApplication } from "../src/application.js";
import { openWorkspaceFileReference } from "../src/vscodeContextHost.js";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("blooddot.dext");
  assert.ok(extension, "Dext extension is discoverable.");
  await extension.activate();
  assert.equal(extension.isActive, true, "Dext extension activates.");

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("dext.focus"), "Focus command is registered.");
  assert.ok(commands.includes("dext.reloadMethods"), "Reload command is registered.");
  assert.ok(commands.includes("dext.openHistory"), "History command is registered.");
  assert.ok(commands.includes("dext.openWorkspaceTrust"), "Workspace Trust command is registered.");
  assert.ok(commands.includes("dext.workspaceTrustedStatus"), "Trusted workspace title action is registered.");
  assert.ok(commands.includes("dext.workspaceUntrustedStatus"), "Untrusted workspace title action is registered.");
  assert.ok(commands.includes("dext.triggerSuggest"), "Suggest command is registered.");
  assert.ok(commands.includes("dext.triggerParameterHints"), "Parameter hints command is registered.");
  assert.ok(commands.includes("dext.addSelectionToChat"), "Selection attachment command is registered.");
  assert.ok(commands.includes("dext.copySelectionWithContext"), "Context copy command is registered.");
  assert.ok(commands.includes("dext.addFileToChat"), "File attachment command is registered.");
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
  try {
    const submittedText = await vscode.commands.executeCommand<string>("dext.copySelectionWithContext");
    assert.equal(submittedText, copiedText, "Context copy submits the exact selection text.");
    if (clipboardBaseline) {
      assert.equal(await vscode.env.clipboard.readText(), copiedText, "Context copy writes exact selection text.");
    }
  } finally {
    await vscode.env.clipboard.writeText(originalClipboard);
  }

  await vscode.commands.executeCommand("dext.addSelectionToChat");
  await vscode.commands.executeCommand("dext.addFileToChat", file);

  const app = new DextApplication();
  await app.reload();
  const response = await app.executeInput('code.explain(target=[ref.file("package.json#L1,1-L1,2")])');
  const snapshot = response.executions[0];
  assert.equal(snapshot?.result.kind, "explain", "A file reference fragment resolves for explanation.");
  if (snapshot?.result.kind === "explain") {
    assert.equal(snapshot.result.files[0]?.content, "{", "A file reference fragment resolves its exact range.");
  }
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
  const methodStart = dxDocument.getText().indexOf("code.explain");
  assert.ok(methodStart >= 0, "The Dext language fixture contains a built-in API call.");
  const completionPosition = dxDocument.positionAt(methodStart + "code.".length);
  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    dxDocument.uri,
    completionPosition,
    "."
  );
  assert.ok(
    completions.items.some((item) => item.label === "explain"),
    "A .dx file receives API completions from the registered VS Code provider."
  );
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    dxDocument.uri,
    dxDocument.positionAt(methodStart + "code.ex".length)
  );
  assert.ok(hovers.length > 0, "A .dx API call receives hover type information.");
  const targetValue = dxDocument.getText().indexOf("target=target", methodStart);
  const signatures = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    "vscode.executeSignatureHelpProvider",
    dxDocument.uri,
    dxDocument.positionAt(targetValue + "target=".length),
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
}
