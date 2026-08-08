import assert from "node:assert/strict";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("blooddot.dext");
  assert.ok(extension, "Dext extension is discoverable.");
  await extension.activate();
  assert.equal(extension.isActive, true, "Dext extension activates.");

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("dext.focus"), "Focus command is registered.");
  assert.ok(commands.includes("dext.reloadMethods"), "Reload command is registered.");

  await vscode.commands.executeCommand("dext.reloadMethods");
  await vscode.commands.executeCommand("dext.focus");
  await new Promise((resolve) => setTimeout(resolve, 300));
}
