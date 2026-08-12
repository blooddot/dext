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
  const snapshot = await app.executeCode('core.context.snapshot(target: @file("package.json#L1,1-L1,2"))');
  assert.equal(snapshot.result.kind, "code", "A file reference fragment resolves to code.");
  if (snapshot.result.kind === "code") {
    assert.equal(snapshot.result.code, "{", "A file reference fragment resolves its exact range.");
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

  await vscode.commands.executeCommand("dext.triggerSuggest");
  await vscode.commands.executeCommand("dext.triggerParameterHints");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await vscode.commands.executeCommand("dext.reloadMethods");
  await vscode.commands.executeCommand("dext.focus");
  await new Promise((resolve) => setTimeout(resolve, 300));
}
