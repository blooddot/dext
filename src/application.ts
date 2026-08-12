import * as vscode from "vscode";
import { BUILTIN_METHODS } from "./core/builtins.js";
import { compileChat } from "./core/chatCompiler.js";
import { loadMethodConfigs, type ConfigFileCandidate } from "./core/configLoader.js";
import { ContextResolver } from "./core/contextResolver.js";
import { parseInvocation } from "./core/dsl.js";
import { DextLanguageService } from "./core/languageService.js";
import { MethodRegistry } from "./core/registry.js";
import { DextRuntime } from "./core/runtime.js";
import type { CodeRef, RuntimeResponse } from "./core/types.js";
import type { SidebarState } from "./webviewProtocol.js";
import { VsCodeContextHost } from "./vscodeContextHost.js";

export class DextApplication {
  readonly registry = new MethodRegistry();
  readonly language = new DextLanguageService(this.registry);
  readonly runtime = new DextRuntime(
    this.registry,
    new ContextResolver(new VsCodeContextHost())
  );
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
    return {
      trusted: vscode.workspace.isTrusted,
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

  async executeCode(source: string): Promise<RuntimeResponse> {
    const diagnostics = this.language.diagnostics(source);
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    }
    return this.runtime.execute(parseInvocation(source));
  }

  executeChat(message: string, attachments: readonly CodeRef[] = []): Promise<RuntimeResponse> {
    return this.runtime.execute(compileChat(message), attachments);
  }
}
