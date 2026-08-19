import * as vscode from "vscode";
import { BUILTIN_METHODS } from "./core/builtins.js";
import { loadCustomApis } from "./core/customApi.js";
import { ContextResolver } from "./core/contextResolver.js";
import { DextLanguageService } from "./core/languageService.js";
import { MethodRegistry } from "./core/registry.js";
import { DextRuntime } from "./core/runtime.js";
import { compileWorkflow, parseWorkflowImports } from "./core/workflow.js";
import { WorkflowRuntime } from "./core/workflowRuntime.js";
import type { ExecutionMetadata, InputExecutionResponse } from "./core/types.js";
import type { SidebarState } from "./webviewProtocol.js";
import { VsCodeContextHost } from "./vscodeContextHost.js";
import { terminalRunHandler } from "./vscodeTerminalHost.js";
import { applyPatchHandler } from "./vscodePatchHost.js";
import { loadEditorTokenTheme } from "./vscodeTheme.js";
import { AgentProfileStore, type AgentProfile, type AgentSelection } from "./agentProfiles.js";
import { DefaultAioaCdpConnection } from "./core/aioaCdp.js";
import { DefaultAgentRunner } from "./core/agentRouter.js";
import { SkillCatalog } from "./core/skillCatalog.js";
import { McpToolRegistry, type HttpMcpServerConfig, type McpToolConfig } from "./core/mcpRegistry.js";
import { McpAccessTokenStore } from "./core/mcpSecrets.js";

export class DextApplication {
  readonly registry = new MethodRegistry();
  readonly language = new DextLanguageService(this.registry);
  private readonly contextResolver = new ContextResolver(new VsCodeContextHost());
  /** Verification and executed AIOA turns share the same dynamic CDP endpoint
   * for this extension lifetime; profile configuration is never rewritten. */
  private readonly aioaConnection = new DefaultAioaCdpConnection();
  readonly runtime = new DextRuntime(
    this.registry,
    this.contextResolver,
    undefined,
    { terminalRun: terminalRunHandler, applyPatch: applyPatchHandler }
  );
  private readonly workflowRuntime = new WorkflowRuntime(this.runtime);
  private configDiagnostics: string[] = [];
  private customApiIds = new Set<string>();
  private workspaceRoot = process.cwd();
  private workspaceUri: vscode.Uri | undefined;
  private workspaceTrusted = false;
  readonly skills = new SkillCatalog();
  readonly mcp = new McpToolRegistry();
  readonly agents: AgentProfileStore;
  private readonly mcpSecrets: McpAccessTokenStore | undefined;

  constructor(globalState?: vscode.Memento, secretStorage?: vscode.SecretStorage) {
    this.runtime.setAgentRunner(new DefaultAgentRunner(undefined, this.aioaConnection));
    this.agents = new AgentProfileStore(globalState);
    if (secretStorage) {
      const mcpSecrets = new McpAccessTokenStore(secretStorage, () => this.workspaceUri?.toString());
      this.mcpSecrets = mcpSecrets;
      this.mcp.setAccessTokenProvider(async (server) => mcpSecrets.get(server.name));
    }
    this.registry.registerMany(BUILTIN_METHODS, "builtin");
    this.runtime.setAgentProfiles(this.agents.list());
    this.runtime.setAgentSelection(this.agents.currentSelection());
    this.runtime.setSkillLoader((skill, workspace) => this.skills.load(skill, this.workspaceRoot, workspace.path));
    this.runtime.setMcpCaller((tool, input) => this.mcp.call(tool, input));
  }

  async reload(): Promise<void> {
    this.registry.clearExternal();
    const diagnostics: string[] = [];
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.workspaceUri = folder?.uri;
    this.workspaceRoot = folder?.uri.fsPath ?? process.cwd();
    this.workspaceTrusted = vscode.workspace.isTrusted && folder?.uri.scheme === "file";
    this.runtime.setWorkspaceRoot(this.workspaceRoot);
    this.runtime.setWorkspaceTrusted(this.workspaceTrusted);
    const skillDirs = vscode.workspace.getConfiguration("dext").get<string[]>("skillDirs", []);
    const mcpConfiguration = vscode.workspace.getConfiguration("dext");
    diagnostics.push(...this.mcp.setServers(mcpConfiguration.get<unknown[]>("mcpServers", [])));
    diagnostics.push(...this.mcp.setTools(mcpConfiguration.get<McpToolConfig[]>("mcpTools", [])));
    try {
      await this.skills.reload(this.workspaceRoot, skillDirs);
    } catch (error) {
      diagnostics.push(`Skill discovery: ${error instanceof Error ? error.message : String(error)}`);
    }
    const loaded = await loadCustomApis(
      vscode.workspace.isTrusted,
      folder ? [vscode.Uri.joinPath(folder.uri, ".dext", "api").fsPath] : [],
      async (root) => {
        const files: string[] = [];
        const visit = async (directory: vscode.Uri): Promise<void> => {
          let entries: [string, vscode.FileType][];
          try {
            entries = await vscode.workspace.fs.readDirectory(directory);
          } catch (error) {
            if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return;
            throw error;
          }
          for (const [name, type] of entries) {
            const child = vscode.Uri.joinPath(directory, name);
            if (type === vscode.FileType.Directory) await visit(child);
            else if (type === vscode.FileType.File && name.toLowerCase().endsWith(".dx")) files.push(child.fsPath);
          }
        };
        await visit(vscode.Uri.file(root));
        return files;
      },
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
      },
      this.registry,
      "project"
    );
    this.runtime.setCustomPlans(loaded.plans);
    this.customApiIds = new Set(loaded.methods.map(({ definition }) => definition.id));
    this.language.setCustomApiIds(this.customApiIds);
    this.configDiagnostics = [...diagnostics, ...loaded.diagnostics];
    this.language.setSkillCompletions(this.skills.list());
  }

  state(): SidebarState {
    const theme = loadEditorTokenTheme();
    return {
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
      diagnostics: this.configDiagnostics,
      agentProfiles: this.agents.list(),
      agentSelection: this.agents.currentSelection()
    };
  }

  setAgentSelection(selection: AgentSelection): void {
    this.agents.setSelection(selection);
    this.runtime.setAgentSelection(selection);
  }

  updateAgentProfile(profile: AgentProfile): void {
    this.agents.update(profile);
    this.runtime.setAgentProfiles(this.agents.list());
  }

  /** Verifies the configured local AIOA CDP session, launching it when requested. */
  async verifyAioaCdp(): Promise<boolean> {
    const profile = this.agents.list().find((candidate) => candidate.provider === "aioa");
    if (!profile) throw new Error("The AIOA Agent profile is not available.");
    const opened = await this.aioaConnection.open(profile);
    try {
      await opened.page.state();
      return opened.launched;
    } finally {
      await opened.page.close();
    }
  }

  async executeInput(source: string, metadata: Readonly<ExecutionMetadata> = {}): Promise<InputExecutionResponse> {
    const compiled = compileWorkflow(source, this.registry, {
      allowImports: true,
      aliases: parseWorkflowImports(source),
      customApiIds: this.customApiIds,
      requireCustomApiImports: false
    });
    if (!compiled.program || compiled.diagnostics.some((item) => item.severity === "error")) {
      throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
    }
    return this.workflowRuntime.execute(compiled.program, [], metadata);
  }

  async executeConversation(
    mode: "agent" | "ask",
    input: string,
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<InputExecutionResponse> {
    const response = await this.runtime.executeConversation(mode, input, metadata);
    return {
      kind: "workflow",
      executions: [response],
      steps: [{ method: response.method.id, state: "success", response }]
    };
  }

  endAgentSession(sessionId: string): void {
    this.runtime.endAgentSession(sessionId);
  }

  isTrustedLocalWorkspace(): boolean {
    return this.workspaceTrusted;
  }

  bearerHttpServers(): HttpMcpServerConfig[] {
    return this.mcp.listServers().filter((server): server is HttpMcpServerConfig =>
      server.transport === "http" && server.auth?.type === "bearer"
    );
  }

  async setMcpAccessToken(serverName: string, token: string): Promise<void> {
    this.assertBearerHttpServer(serverName);
    if (!this.mcpSecrets) throw new Error("VS Code SecretStorage is not available.");
    await this.mcpSecrets.store(serverName, token);
  }

  async clearMcpAccessToken(serverName: string): Promise<void> {
    this.assertBearerHttpServer(serverName);
    if (!this.mcpSecrets) throw new Error("VS Code SecretStorage is not available.");
    await this.mcpSecrets.delete(serverName);
  }

  async verifyMcpServer(serverName: string): Promise<void> {
    this.assertBearerHttpServer(serverName);
    await this.mcp.verifyServer(serverName);
  }

  private assertBearerHttpServer(serverName: string): void {
    if (!this.workspaceTrusted) throw new Error("MCP credentials require a trusted local workspace.");
    const server = this.mcp.getServer(serverName);
    if (server?.transport !== "http" || server.auth?.type !== "bearer") {
      throw new Error(`MCP server '${serverName}' is not a bearer-authenticated HTTP server.`);
    }
  }
}
