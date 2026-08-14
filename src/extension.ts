import * as vscode from "vscode";
import { DextApplication } from "./application.js";
import { DextSidebarProvider } from "./sidebarProvider.js";
import { DextHistoryStore } from "./historyStore.js";
import { DextHistoryPanel } from "./historyEditorProvider.js";
import { normalizeAioaCdpEndpoint } from "./core/aioaCdp.js";
import {
  dextSemanticTokens,
  DEXT_SEMANTIC_TOKEN_MODIFIERS,
  DEXT_SEMANTIC_TOKEN_TYPES
} from "./dextSemanticTokens.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const application = new DextApplication(context.globalState);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) application.runtime.setWorkspaceRoot(folder.uri.fsPath);
  await application.reload();
  const history = new DextHistoryStore(context.globalState);
  const historyPanel = new DextHistoryPanel(context.extensionUri, history);
  const sidebar = new DextSidebarProvider(
    context.extensionUri,
    application,
    history,
    () => historyPanel.showInActiveEditor()
  );
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
  const activeDextEditor = (): boolean => vscode.window.activeTextEditor?.document.languageId === "dext-api";
  const updateTrustContext = (): void => {
    void vscode.commands.executeCommand("setContext", "dext.workspaceTrusted", vscode.workspace.isTrusted);
  };
  const openWorkspaceTrust = async (): Promise<void> => {
    const available = await vscode.commands.getCommands(true);
    const command = [
      "workbench.trust.manage",
      "workbench.action.manageTrustedUris",
      "workbench.action.configureWorkspaceTrust",
      "workbench.action.manageTrust"
    ].find((candidate) => available.includes(candidate));
    if (command) {
      await vscode.commands.executeCommand(command);
      return;
    }
    await vscode.window.showInformationMessage(
      "Use the Command Palette to run 'Workspaces: Manage Workspace Trust'."
    );
  };
  updateTrustContext();
  const semanticLegend = new vscode.SemanticTokensLegend(
    [...DEXT_SEMANTIC_TOKEN_TYPES],
    [...DEXT_SEMANTIC_TOKEN_MODIFIERS]
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DextSidebarProvider.viewType, sidebar),
    historyPanel,
    vscode.commands.registerCommand("dext.openHistory", () => historyPanel.showInActiveEditor()),
    vscode.commands.registerCommand("dext.focus", async () => {
      await vscode.commands.executeCommand("dext.sidebar.focus");
      sidebar.focusEditor();
    }),
    vscode.commands.registerCommand("dext.reloadMethods", async () => {
      await application.reload();
      await sidebar.refresh();
    }),
    vscode.commands.registerCommand("dext.openWorkspaceTrust", openWorkspaceTrust),
    vscode.commands.registerCommand("dext.workspaceTrustedStatus", openWorkspaceTrust),
    vscode.commands.registerCommand("dext.workspaceUntrustedStatus", openWorkspaceTrust),
    vscode.commands.registerCommand("dext.triggerSuggest", async () => {
      if (activeDextEditor()) {
        await vscode.commands.executeCommand("editor.action.triggerSuggest");
        return;
      }
      await focusSidebar();
      sidebar.triggerSuggest();
    }),
    vscode.commands.registerCommand("dext.triggerParameterHints", async () => {
      if (activeDextEditor()) {
        await vscode.commands.executeCommand("editor.action.triggerParameterHints");
        return;
      }
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
    vscode.commands.registerCommand("dext.configureAgent", async () => {
      const profiles = application.agents.list();
      const picked = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
          label: profile.label,
          description: profile.provider === "aioa"
            ? `${profile.connectionMode === "launch" ? "Launch" : "Attach"} · ${profile.endpoint ?? "CDP not configured"}`
            : profile.command || "Command not configured",
          profile
        })),
        { placeHolder: "Choose an Agent profile" }
      );
      if (!picked) return;
      if (picked.profile.provider === "aioa") {
        const connection = await vscode.window.showQuickPick([
          {
            label: "Launch",
            description: "Dext starts AIOA with a local CDP port when no compatible instance is running.",
            mode: "launch" as const
          },
          {
            label: "Attach",
            description: "Connect to an AIOA instance already started with a local CDP port.",
            mode: "attach" as const
          }
        ], { placeHolder: "Choose how Dext connects to AIOA" });
        if (!connection) return;
        const rawEndpoint = await vscode.window.showInputBox({
          prompt: "AIOA CDP URL (local loopback only)",
          value: picked.profile.endpoint ?? "http://127.0.0.1:9229",
          ignoreFocusOut: true
        });
        if (rawEndpoint === undefined) return;
        let endpoint: string;
        try {
          endpoint = normalizeAioaCdpEndpoint(rawEndpoint);
        } catch (error) {
          await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
          return;
        }
        let command = picked.profile.command;
        if (connection.mode === "launch") {
          const executable = await vscode.window.showInputBox({
            prompt: "AIOA executable path",
            value: command,
            ignoreFocusOut: true
          });
          if (executable === undefined) return;
          command = executable.trim();
        }
        application.updateAgentProfile({
          ...picked.profile,
          command,
          endpoint,
          connectionMode: connection.mode
        });
        try {
          const launched = await application.verifyAioaCdp();
          await vscode.window.showInformationMessage(
            launched ? "AIOA started and its CDP session is ready." : "AIOA CDP session is ready."
          );
        } catch (error) {
          await vscode.window.showWarningMessage(
            `AIOA settings were saved, but CDP is not ready yet: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        await sidebar.refresh();
        return;
      }
      const command = await vscode.window.showInputBox({
        prompt: `CLI command for ${picked.profile.label}`,
        value: picked.profile.command,
        ignoreFocusOut: true
      });
      if (command === undefined) return;
      const models = await vscode.window.showInputBox({
        prompt: "Supported models, separated by commas; leave empty for CLI default",
        value: picked.profile.models.join(", "),
        ignoreFocusOut: true
      });
      if (models === undefined) return;
      application.updateAgentProfile({
        ...picked.profile,
        command: command.trim(),
        models: models.split(",").map((model) => model.trim()).filter(Boolean)
      });
      await sidebar.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (
        event.affectsConfiguration("workbench.colorTheme")
        || event.affectsConfiguration("workbench.preferredDarkColorTheme")
        || event.affectsConfiguration("workbench.preferredLightColorTheme")
        || event.affectsConfiguration("workbench.preferredHighContrastColorTheme")
        || event.affectsConfiguration("workbench.preferredHighContrastLightColorTheme")
        || event.affectsConfiguration("window.autoDetectColorScheme")
        || event.affectsConfiguration("window.autoDetectHighContrast")
        || event.affectsConfiguration("editor.tokenColorCustomizations")
      ) {
        await sidebar.refresh();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => sidebar.refresh()),
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      updateTrustContext();
      await application.reload();
      await sidebar.refresh();
    }),
    vscode.languages.registerCompletionItemProvider(
      { language: "dext-api", scheme: "file" },
      {
        provideCompletionItems(document, position) {
          const source = document.getText();
          const cursor = document.offsetAt(position);
          const relative = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, "/");
          const marker = ".dext/api/";
          const index = relative.indexOf(marker);
          const apiId = index >= 0 ? relative.slice(index + marker.length).replace(/\.dx$/i, "").replace(/\//g, ".") : undefined;
          return application.language.apiCompletions(source, cursor, apiId).map((candidate) => {
            const completion = new vscode.CompletionItem(
              candidate.label,
              candidate.kind === "namespace" ? vscode.CompletionItemKind.Module :
                candidate.kind === "method" ? vscode.CompletionItemKind.Function :
                  candidate.kind === "parameter" ? vscode.CompletionItemKind.Field : vscode.CompletionItemKind.Value
            );
            completion.detail = candidate.detail;
            completion.insertText = candidate.insertText;
            completion.range = new vscode.Range(document.positionAt(candidate.replaceStart), document.positionAt(candidate.replaceEnd));
            return completion;
          });
        }
      },
      ".",
      " "
    ),
    vscode.languages.registerHoverProvider(
      { language: "dext-api", scheme: "file" },
      {
        provideHover(document, position) {
          const source = document.getText();
          const cursor = document.offsetAt(position);
          const hover = application.language.apiHover(source, cursor);
          if (!hover) return undefined;
          return new vscode.Hover(
            new vscode.MarkdownString(`**${hover.label}**\n\n${hover.documentation}`),
            new vscode.Range(document.positionAt(hover.rangeStart), document.positionAt(hover.rangeEnd))
          );
        }
      }
    ),
    vscode.languages.registerSignatureHelpProvider(
      { language: "dext-api", scheme: "file" },
      {
        provideSignatureHelp(document, position) {
          const source = document.getText();
          const signature = application.language.apiSignature(source, document.offsetAt(position));
          if (!signature) return undefined;
          const item = new vscode.SignatureInformation(signature.label, signature.documentation);
          item.parameters = signature.parameters.map((parameter) => new vscode.ParameterInformation(parameter.label, parameter.documentation));
          const result = new vscode.SignatureHelp();
          result.signatures = [item];
          result.activeSignature = 0;
          result.activeParameter = signature.activeParameter;
          return result;
        }
      },
      "(", ","
    ),
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "dext-api", scheme: "file" },
      {
        provideDocumentSemanticTokens(document) {
          const builder = new vscode.SemanticTokensBuilder(semanticLegend);
          for (const token of dextSemanticTokens(document.getText())) {
            builder.push(
              new vscode.Range(document.positionAt(token.from), document.positionAt(token.to)),
              token.type,
              token.declaration ? ["declaration"] : []
            );
          }
          return builder.build();
        }
      },
      semanticLegend
    )
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/.dext/api/**/*.dx");
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
