import { isAbsolute } from "node:path";
import * as vscode from "vscode";
import { BUILTIN_METHODS } from "./core/builtins.js";
import { loadCustomApis } from "./core/customApi.js";
import { ContextResolver } from "./core/contextResolver.js";
import { DextLanguageService } from "./core/languageService.js";
import { MethodRegistry } from "./core/registry.js";
import { DextRuntime } from "./core/runtime.js";
import { compileWorkflow, parseWorkflowImports } from "./core/workflow.js";
import { DEFAULT_MAX_CONCURRENCY, WorkflowRuntime } from "./core/workflowRuntime.js";
import type { ExecutionMetadata, InputExecutionResponse } from "./core/types.js";
import type { SidebarState } from "./webviewProtocol.js";
import { VsCodeContextHost } from "./vscodeContextHost.js";
import { terminalRunHandler } from "./vscodeTerminalHost.js";
import { applyPatchHandler } from "./vscodePatchHost.js";
import { loadEditorTokenTheme } from "./vscodeTheme.js";
import {
  AgentProfileStore,
  AGENT_PERMISSIONS,
  type AgentPermission,
  type AgentProfile,
  type AgentProvider,
  type AgentSelection
} from "./agentProfiles.js";
import { DefaultAioaCdpConnection } from "./core/aioaCdp.js";
import { DefaultAgentRunner } from "./core/agentRouter.js";
import { SkillCatalog } from "./core/skillCatalog.js";
import { McpToolRegistry, type HttpMcpServerConfig, type McpToolConfig } from "./core/mcpRegistry.js";
import { McpAccessTokenStore } from "./core/mcpSecrets.js";
import {
  COMPLETION_FIELDS,
  CompletionKeyStore,
  normalizeCompletionSettings,
  type CompletionSettings
} from "./core/completionProvider.js";
import { DEFAULT_PLAN_DIRECTORY, planFileName, planPathSegments } from "./core/planFile.js";

/** Global rather than per-workspace: the object form is rewritten in the user
 * settings file, so once is once for every window. */
const COMPLETION_MIGRATION_KEY = "dext.completion.migrated";

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
  private readonly agentRunner: DefaultAgentRunner;
  private readonly mcpSecrets: McpAccessTokenStore | undefined;
  private readonly completionSecrets: CompletionKeyStore | undefined;
  private readonly globalState: vscode.Memento | undefined;

  constructor(globalState?: vscode.Memento, secretStorage?: vscode.SecretStorage) {
    this.globalState = globalState;
    this.agentRunner = new DefaultAgentRunner(undefined, this.aioaConnection);
    this.runtime.setAgentRunner(this.agentRunner);
    this.agents = new AgentProfileStore(globalState);
    if (secretStorage) {
      const mcpSecrets = new McpAccessTokenStore(secretStorage, () => this.workspaceUri?.toString());
      this.mcpSecrets = mcpSecrets;
      this.mcp.setAccessTokenProvider(async (server) => mcpSecrets.get(server.name));
      this.completionSecrets = new CompletionKeyStore(secretStorage, () => this.workspaceUri?.toString());
    }
    this.registry.registerMany(BUILTIN_METHODS, "builtin");
    this.runtime.setAgentProfiles(this.agents.list());
    this.runtime.setAgentSelection(this.agents.currentSelection());
    this.runtime.setSkillLoader((skill, workspace) => this.skills.load(skill, this.workspaceRoot, workspace.path));
    this.runtime.setRuleLoader(async (path) => {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
        return new TextDecoder().decode(bytes);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
        throw error;
      }
    });
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
    this.applyTimeoutSettings();
    this.applyAgentPermissionSettings();
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
      this.apiDirectories(folder),
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

  /** A timeout that fires cuts the turn off with nothing the user can do about
   * it, so these follow the settings rather than the values they were built
   * with. Nonsense values fall back to the default instead of failing a run. */
  applyTimeoutSettings(): void {
    const configuration = vscode.workspace.getConfiguration("dext");
    const positive = (key: string, fallback: number): number => {
      const value = configuration.get<number>(key, fallback);
      return Number.isInteger(value) && value > 0 ? value : fallback;
    };
    this.agentRunner.setTimeouts({
      agentTimeoutMs: positive("agent.timeoutMs", 600_000),
      aioaTimeoutMs: positive("aioa.timeoutMs", 3_600_000),
      aioaIdleTimeoutMs: positive("aioa.idleTimeoutMs", 90_000)
    });
    this.workflowRuntime.setMaxConcurrency(positive("workflow.maxConcurrency", DEFAULT_MAX_CONCURRENCY));
  }

  /** `.dext/api` is always searched; `dext.apiDirs` adds to it. Relative entries
   * resolve from the workspace, and the built-in directory stays first so a
   * configured directory cannot shadow a project's own API. */
  private apiDirectories(folder: vscode.WorkspaceFolder | undefined): string[] {
    if (!folder) return [];
    const roots = [vscode.Uri.joinPath(folder.uri, ".dext", "api").fsPath];
    const configured = vscode.workspace.getConfiguration("dext").get<string[]>("apiDirs", []) ?? [];
    for (const entry of configured) {
      const value = typeof entry === "string" ? entry.trim() : "";
      if (!value) continue;
      const uri = isAbsolute(value) ? vscode.Uri.file(value) : vscode.Uri.joinPath(folder.uri, value);
      if (!roots.includes(uri.fsPath)) roots.push(uri.fsPath);
    }
    return roots;
  }

  /** The permission default and the passthrough arguments are both settings, so
   * they are re-read whenever configuration changes rather than cached at
   * construction. */
  applyAgentPermissionSettings(): void {
    const configuration = vscode.workspace.getConfiguration("dext");
    const configured = configuration.get<string>("agentPermission", "workspace-write");
    this.runtime.setDefaultAgentPermission(
      AGENT_PERMISSIONS.includes(configured as AgentPermission)
        ? configured as AgentPermission
        : "workspace-write"
    );
    const raw = configuration.get<Record<string, unknown>>("agentCliArgs", {}) ?? {};
    const byProvider: Partial<Record<AgentProvider, readonly string[]>> = {};
    for (const provider of ["codex", "claude", "aioa"] as const) {
      const value = raw[provider];
      if (!Array.isArray(value)) continue;
      const args = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
      if (args.length) byProvider[provider] = args;
    }
    this.runtime.setAgentCliArguments(byProvider);
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
      agentSelection: this.agents.currentSelection(),
      settings: this.webviewSettings()
    };
  }

  /** The webview cannot read configuration itself, so the settings it renders
   * with travel with the rest of its state. */
  private webviewSettings(): NonNullable<SidebarState["settings"]> {
    const configuration = vscode.workspace.getConfiguration("dext");
    const diffView = configuration.get<string>("diff.defaultView", "inline");
    return {
      diffView: diffView === "split" ? "split" : "inline",
      submitOnEnter: configuration.get<boolean>("submitOnEnter", true) !== false
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
    mode: "agent" | "ask" | "plan",
    input: string,
    metadata: Readonly<ExecutionMetadata> = {}
  ): Promise<InputExecutionResponse> {
    const response = await this.runtime.executeConversation(mode, input, metadata);
    const saved = mode === "plan" ? await this.savePlan(input, response) : response;
    return {
      kind: "workflow",
      executions: [saved],
      steps: [{ method: saved.method.id, state: "success", response: saved }]
    };
  }

  /** A plan is only useful if it survives the turn, so Plan mode lands the reply
   * in the workspace and hands the path back for the output to link. */
  private async savePlan(input: string, response: InputExecutionResponse["executions"][number]): Promise<InputExecutionResponse["executions"][number]> {
    const result = response.result;
    if (result.kind !== "chat" || !result.text.trim()) return response;
    if (!this.workspaceTrusted || !this.workspaceUri) return response;
    const configured = vscode.workspace.getConfiguration("dext").get<string>("plan.directory", DEFAULT_PLAN_DIRECTORY).trim();
    const segments = planPathSegments(configured || DEFAULT_PLAN_DIRECTORY);
    const directory = vscode.Uri.joinPath(this.workspaceUri, ...segments);
    const name = planFileName(input, new Date());
    const target = vscode.Uri.joinPath(directory, name);
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`${result.text.trimEnd()}\n`));
    const planPath = [...segments, name].join("/");
    return { ...response, result: { ...result, planPath } };
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

  /** Each field is its own setting rather than one object, because the Settings
   * UI renders an object as an untyped key/value table with an Add Item button:
   * no dropdown for the format, and no box to type the URL into. */
  completionSettings(): CompletionSettings {
    const configuration = vscode.workspace.getConfiguration("dext.completion");
    const raw: Record<string, unknown> = {};
    for (const field of COMPLETION_FIELDS) {
      const value = configuration.get(field);
      if (value !== undefined) raw[field] = value;
    }
    return normalizeCompletionSettings(raw);
  }

  /** These settings were once a single `dext.completion` object. VS Code builds
   * its configuration tree by splitting keys on dots, so a leftover object and
   * the flat keys land on the same node and merge in file order: a stale empty
   * `model` could win over the one the wizard just wrote. Moving the values out
   * and deleting the object is the only way to make that predictable.
   *
   * Two things make this delicate. `inspect("completion")` returns the merged
   * node, so once the flat keys exist it reports an object that is really just
   * those keys read back; deleting on the strength of that would target the node
   * they live under. And this runs in every window, so a mistake compounds. It
   * therefore only deletes when a value was genuinely carried across, and only
   * ever runs once. Returns whether anything moved. */
  async migrateCompletionSettings(): Promise<boolean> {
    if (this.globalState?.get<boolean>(COMPLETION_MIGRATION_KEY)) return false;
    const configuration = vscode.workspace.getConfiguration("dext");
    const legacy = configuration.inspect("completion");
    const scoped = vscode.workspace.getConfiguration("dext.completion");
    let migrated = false;
    for (const [target, raw] of [
      [vscode.ConfigurationTarget.Global, legacy?.globalValue],
      [vscode.ConfigurationTarget.Workspace, legacy?.workspaceValue]
    ] as const) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const values = raw as Record<string, unknown>;
      let carried = false;
      for (const field of COMPLETION_FIELDS) {
        if (values[field] === undefined) continue;
        // A flat key already set at this scope is the newer value, so the
        // object never overwrites it, and reading it back is not a migration.
        const existing = scoped.inspect(field);
        const set = target === vscode.ConfigurationTarget.Global
          ? existing?.globalValue
          : existing?.workspaceValue;
        if (set !== undefined) continue;
        await scoped.update(field, values[field], target);
        carried = true;
      }
      if (!carried) continue;
      await configuration.update("completion", undefined, target);
      migrated = true;
    }
    await this.globalState?.update(COMPLETION_MIGRATION_KEY, true);
    return migrated;
  }

  /** Where the value actually in force came from. A completion model is written
   * globally, so anything else means a project is overriding it, or that the
   * global write never landed. */
  completionSettingScope(field: keyof CompletionSettings): string {
    const inspected = vscode.workspace.getConfiguration("dext.completion").inspect(field);
    if (inspected?.workspaceFolderValue !== undefined) return "folder";
    if (inspected?.workspaceValue !== undefined) return "workspace";
    if (inspected?.globalValue !== undefined) return "user";
    return "default";
  }

  /** Writes only the fields the wizard collected, so the tuning values someone
   * edited by hand survive. Global because a completion model follows the
   * person rather than the repository. */
  async writeCompletionSettings(patch: Partial<CompletionSettings>): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("dext.completion");
    for (const [field, value] of Object.entries(patch)) {
      await configuration.update(field, value, vscode.ConfigurationTarget.Global);
    }
  }

  async completionApiKey(): Promise<string | undefined> {
    if (!this.completionSecrets) return undefined;
    try {
      return await this.completionSecrets.get();
    } catch {
      // Secret storage can be unavailable; a missing key is not an error at read time.
      return undefined;
    }
  }

  async setCompletionApiKey(value: string): Promise<void> {
    if (!this.completionSecrets) throw new Error("VS Code SecretStorage is not available.");
    await this.completionSecrets.store(value);
  }

  async clearCompletionApiKey(): Promise<void> {
    if (!this.completionSecrets) throw new Error("VS Code SecretStorage is not available.");
    await this.completionSecrets.delete();
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
