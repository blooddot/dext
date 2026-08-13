import * as vscode from "vscode";
import { BUILTIN_METHODS } from "./core/builtins.js";
import { loadMethodConfigs, type ConfigFileCandidate } from "./core/configLoader.js";
import { ContextResolver } from "./core/contextResolver.js";
import { DextLanguageService } from "./core/languageService.js";
import { MethodRegistry } from "./core/registry.js";
import { DextRuntime } from "./core/runtime.js";
import { compileWorkflow } from "./core/workflow.js";
import { WorkflowRuntime } from "./core/workflowRuntime.js";
import type { InputExecutionResponse } from "./core/types.js";
import type { SidebarState } from "./webviewProtocol.js";
import { VsCodeContextHost } from "./vscodeContextHost.js";
import { terminalRunHandler } from "./vscodeTerminalHost.js";
import { loadEditorTokenTheme } from "./vscodeTheme.js";

export class DextApplication {
  readonly registry = new MethodRegistry();
  readonly language = new DextLanguageService(this.registry);
  private readonly contextResolver = new ContextResolver(new VsCodeContextHost());
  readonly runtime = new DextRuntime(
    this.registry,
    this.contextResolver,
    undefined,
    { terminalRun: terminalRunHandler }
  );
  private readonly workflowRuntime = new WorkflowRuntime(this.runtime);
  private configDiagnostics: string[] = [];

  constructor() {
    this.registry.registerMany(BUILTIN_METHODS, "builtin");
  }

  async reload(): Promise<void> {
    this.registry.clearExternal();
    const candidates: ConfigFileCandidate[] = [];
    const globalFile = vscode.workspace
      .getConfiguration("dext")
      .get<string>("globalMethodsFile", "")
      .trim();
    if (globalFile) {
      candidates.push({ source: "global", path: globalFile });
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      candidates.push({
        source: "project",
        path: vscode.Uri.joinPath(folder.uri, ".dext", "methods.json").fsPath
      });
    }

    const loaded = await loadMethodConfigs(
      vscode.workspace.isTrusted,
      candidates,
      async (filePath) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
          return new TextDecoder().decode(bytes);
        } catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
            return undefined;
          }
          throw error;
        }
      }
    );
    for (const entry of loaded.methods) {
      this.registry.register(entry.definition, entry.source);
    }
    this.configDiagnostics = loaded.diagnostics;
  }

  state(): SidebarState {
    const theme = loadEditorTokenTheme();
    return {
      trusted: vscode.workspace.isTrusted,
      ...(theme ? { theme } : {}),
      methods: this.registry.list().map((method) => ({
        id: method.id,
        title: method.title,
        description: method.description,
        kind: method.kind,
        source: method.source,
        input: method.input,
        output: method.output
      })),
      diagnostics: this.configDiagnostics
    };
  }

  async executeInput(source: string): Promise<InputExecutionResponse> {
    const compiled = compileWorkflow(source, this.registry);
    if (!compiled.program || compiled.diagnostics.some((item) => item.severity === "error")) {
      throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
    }
    return this.workflowRuntime.execute(compiled.program);
  }
}
