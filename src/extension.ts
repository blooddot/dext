import * as vscode from "vscode";
import { DextApplication } from "./application.js";
import { DextSidebarProvider } from "./sidebarProvider.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const application = new DextApplication();
  await application.reload();
  const sidebar = new DextSidebarProvider(context.extensionUri, application);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DextSidebarProvider.viewType, sidebar),
    vscode.commands.registerCommand("dext.focus", async () => {
      await vscode.commands.executeCommand("dext.sidebar.focus");
      sidebar.focusEditor();
    }),
    vscode.commands.registerCommand("dext.reloadMethods", async () => {
      await application.reload();
      await sidebar.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("dext.globalMethodsFile")) {
        await application.reload();
        await sidebar.refresh();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      await application.reload();
      await sidebar.refresh();
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/.dext/methods.json");
  const reload = async (): Promise<void> => {
    await application.reload();
    await sidebar.refresh();
  };
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);
}

export function deactivate(): void {}
