import * as vscode from "vscode";
import { DextApplication } from "./application.js";
import { DextSidebarProvider } from "./sidebarProvider.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const application = new DextApplication();
  await application.reload();
  const sidebar = new DextSidebarProvider(context.extensionUri, application);
  const reportCommandError = async <T>(run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };
  const focusSidebar = async (): Promise<void> => {
    await vscode.commands.executeCommand("dext.sidebar.focus");
  };

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
    vscode.commands.registerCommand("dext.triggerSuggest", async () => {
      await focusSidebar();
      sidebar.triggerSuggest();
    }),
    vscode.commands.registerCommand("dext.triggerParameterHints", async () => {
      await focusSidebar();
      sidebar.triggerParameterHints();
    }),
    vscode.commands.registerCommand("dext.addSelectionToChat", () =>
      reportCommandError(async () => {
        await sidebar.addSelectionToChat();
        await focusSidebar();
        sidebar.showChat();
      })
    ),
    vscode.commands.registerCommand("dext.copySelectionWithContext", () =>
      reportCommandError(() => sidebar.copySelectionWithContext())
    ),
    vscode.commands.registerCommand("dext.addFileToChat", (resource?: vscode.Uri) =>
      reportCommandError(async () => {
        await sidebar.addFileToChat(resource);
        await focusSidebar();
        sidebar.showChat();
      })
    ),
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
  context.subscriptions.push(watcher, sidebar);
}

export function deactivate(): void {}
