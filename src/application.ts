import { isAbsolute, sep } from "node:path";
import * as vscode from "vscode";
import { applyEdits, modify } from "jsonc-parser/lib/esm/main.js";
import { BUILTIN_METHODS } from "./core/builtins.js";
import { loadCustomApis } from "./core/customApi.js";
import { ContextResolver } from "./core/contextResolver.js";
import { DextLanguageService } from "./core/languageService.js";
import { MethodRegistry } from "./core/registry.js";
import { DextRuntime } from "./core/runtime.js";
import { compileWorkflow, parseWorkflowImports } from "./core/workflow.js";
import { DEFAULT_MAX_CONCURRENCY, WorkflowRuntime } from "./core/workflowRuntime.js";
import type { CallableDefinition, DextResult, ExecutionMetadata, InputExecutionResponse } from "./core/types.js";
import type { GlobalResourceItem, GlobalResources, SidebarState } from "./webviewProtocol.js";
import { VsCodeContextHost } from "./vscodeContextHost.js";
import { terminalRunHandler } from "./vscodeTerminalHost.js";
import { applyPatchHandler } from "./vscodePatchHost.js";
import { loadEditorTokenTheme } from "./vscodeTheme.js";
import {
  AgentProfileStore,
  AGENT_PERMISSIONS,
  SUPPORTED_AGENT_PROFILE_IDS,
  type WritableAgentPermission,
  type AgentProfile,
  type AgentProvider,
  type AgentSelection
} from "./agentProfiles.js";
import { DefaultAgentRunner } from "./core/agentRouter.js";
import { SkillCatalog } from "./core/skillCatalog.js";
import { McpToolRegistry, type McpServerConfig, type McpToolConfig, type McpDiscoveredTool } from "./core/mcpRegistry.js";
import { McpAccessTokenStore } from "./core/mcpSecrets.js";
import { parseMcpManifest } from "./core/mcpManifest.js";
import {
  COMPLETION_FIELDS,
  CompletionKeyStore,
  normalizeCompletionSettings,
  type CompletionSettings
} from "./core/completionProvider.js";
import { DEFAULT_PLAN_DIRECTORY, planFileName, planPathSegments } from "./core/planFile.js";
import { splitPlanResponse } from "./core/planResponse.js";
import { DextStorage } from "./dextStorage.js";

/** Global rather than per-workspace: the object form is rewritten in the user
 * settings file, so once is once for every window. */
const COMPLETION_MIGRATION_KEY = "dext.completion.migrated";

export class DextApplication {
  readonly registry = new MethodRegistry();
  readonly language = new DextLanguageService(this.registry);
  private readonly contextResolver = new ContextResolver(new VsCodeContextHost());
  readonly runtime = new DextRuntime(
    this.registry,
    this.contextResolver,
    undefined,
    { terminalRun: terminalRunHandler, applyPatch: applyPatchHandler }
  );
  private readonly workflowRuntime = new WorkflowRuntime(this.runtime);
  private configDiagnostics: string[] = [];
  private customApiIds = new Set<string>();
  private readonly customApiSources = new Map<string, string>();

  customApiSourcePath(id: string): string | undefined {
    return this.customApiSources.get(id);
  }
  private workspaceRoot = process.cwd();
  private workspaceUri: vscode.Uri | undefined;
  private workspaceTrusted = false;
  private globalResources: GlobalResources = { apis: [], mcps: [], rules: [], skills: [] };
  private globalDiagnostics: string[] = [];
  readonly skills = new SkillCatalog();
  readonly mcp = new McpToolRegistry();
  readonly agents: AgentProfileStore;
  private readonly agentRunner: DefaultAgentRunner;
  private readonly mcpSecrets: McpAccessTokenStore | undefined;
  private readonly completionSecrets: CompletionKeyStore | undefined;
  private readonly globalState: vscode.Memento | undefined;
  readonly storage: DextStorage;

  constructor(globalState?: vscode.Memento, secretStorage?: vscode.SecretStorage, globalStorageUri?: vscode.Uri) {
    this.globalState = globalState;
    // Extension activation always supplies VS Code's Dext-specific global
    // storage root. The plain file URI keeps lightweight hostless tests from
    // needing to implement Uri.joinPath just to construct the application.
    this.storage = new DextStorage(globalStorageUri ?? vscode.Uri.file(process.cwd()));
    this.agentRunner = new DefaultAgentRunner();
    this.runtime.setAgentRunner(this.agentRunner);
    this.agents = new AgentProfileStore(globalState);
    this.agentRunner.harness.onModels = (profile, options) => {
      const saved = this.agents.list().find((item) => item.id === profile.id);
      const modelOptions = [...(saved?.modelOptions ?? []).filter((item) => !options.some((next) => next.id === item.id)), ...options];
      this.updateAgentProfile({ ...profile, models: modelOptions.map((item) => item.id), modelOptions });
    };
    if (secretStorage) {
      const mcpSecrets = new McpAccessTokenStore(secretStorage, () => this.workspaceUri?.toString());
      this.mcpSecrets = mcpSecrets;
      this.mcp.setAccessTokenProvider(async (server) => mcpSecrets.get(
        server.name,
        server.scope === "global" ? "global" : "workspace",
        server.transport === "http" ? "bearer" : "token"
      ));
      this.completionSecrets = new CompletionKeyStore(secretStorage, () => this.workspaceUri?.toString());
    }
    this.registry.registerMany(BUILTIN_METHODS, "builtin");
    this.refreshAgentProfiles();
    this.runtime.setAgentSelection(this.agents.currentSelection());
    this.runtime.setSkillLoader((skill, workspace) => this.skills.load(skill, this.workspaceRoot, workspace.path));
    this.runtime.setRuleLoader(async (path) => {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
        return new TextDecoder().decode(bytes);
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
          const projectRulesRoot = vscode.Uri.joinPath(vscode.Uri.file(this.workspaceRoot), ".dext", "rules").fsPath;
          const relativePath = path.startsWith(`${projectRulesRoot}${sep}`)
            ? path.slice(projectRulesRoot.length + 1)
            : undefined;
          if (relativePath) {
            try {
              const globalFile = vscode.Uri.joinPath(this.storage.globalStorageUri, "rules", ...relativePath.split(/[\\\\/]/));
              const bytes = await vscode.workspace.fs.readFile(globalFile);
              return new TextDecoder().decode(bytes);
            } catch (globalError) {
              if (globalError instanceof vscode.FileSystemError && globalError.code === "FileNotFound") return undefined;
              throw globalError;
            }
          }
          return undefined;
        }
        throw error;
      }
    });
    this.runtime.setMcpCaller((tool, input, onProcessEvent) => this.mcp.call(tool, input, {
      ...(onProcessEvent ? { onProcessEvent } : {})
    }));
    this.runtime.setCreateHandler(({ arguments: args, metadata }) => this.createResource(args, metadata));
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
    const mcpManifests = await this.loadMcpManifests(folder);
    const mcpRegistryDiagnostics = [
      ...this.mcp.setServers(mcpManifests.servers),
      ...this.mcp.setTools(mcpManifests.tools)
    ];
    diagnostics.push(...mcpManifests.diagnostics, ...mcpRegistryDiagnostics);
    const activeMcpTools = new Set(this.mcp.list().map((tool) => `${tool.server}.${tool.tool}`));
    this.registry.registerMany(
      mcpManifests.methods.filter((method) => activeMcpTools.has(method.id.slice("mcp.".length))),
      "project"
    );
    try {
      await this.skills.reload(this.workspaceRoot, skillDirs, vscode.Uri.joinPath(this.storage.globalStorageUri, "skills").fsPath);
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
    this.customApiSources.clear();
    const registered = new Set(loaded.methods.map(({ definition }) => definition));
    for (const file of loaded.files) {
      if (registered.has(file.definition)) this.customApiSources.set(file.id, file.path);
    }
    this.customApiIds = new Set(loaded.methods.map(({ definition }) => definition.id));
    this.language.setCustomApiIds(this.customApiIds);
    const globalRoot = vscode.Uri.joinPath(this.storage.globalStorageUri, "api").fsPath.replace(/[\\/]$/, "");
    const isGlobalApiDiagnostic = (message: string): boolean => {
      const normalized = message.replaceAll("\\", "/").toLowerCase();
      return normalized.startsWith(`${globalRoot.replaceAll("\\", "/").toLowerCase()}/`);
    };
    const globalApiDiagnostics = loaded.diagnostics.filter(isGlobalApiDiagnostic);
    const projectApiDiagnostics = loaded.diagnostics.filter((message) => !isGlobalApiDiagnostic(message));
    const nonMcpDiagnostics = diagnostics.filter((message) =>
      !mcpManifests.diagnostics.includes(message) && !mcpRegistryDiagnostics.includes(message)
    );
    this.configDiagnostics = [
      ...mcpManifests.projectDiagnostics,
      ...projectApiDiagnostics,
      ...nonMcpDiagnostics
    ];
    this.globalDiagnostics = [
      ...mcpManifests.globalDiagnostics,
      ...globalApiDiagnostics,
      ...mcpRegistryDiagnostics
    ];
    this.language.setSkillCompletions(this.skills.list());
    this.globalResources = await this.loadGlobalResources();
  }

  private async loadGlobalResources(): Promise<GlobalResources> {
    const root = this.storage.globalStorageUri;
    const listFiles = async (directory: vscode.Uri, extension?: string): Promise<string[]> => {
      const files: string[] = [];
      const visit = async (current: vscode.Uri): Promise<void> => {
        let entries: [string, vscode.FileType][];
        try { entries = await vscode.workspace.fs.readDirectory(current); }
        catch (error) {
          if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return;
          throw error;
        }
        for (const [name, type] of entries) {
          const child = vscode.Uri.joinPath(current, name);
          if (type === vscode.FileType.Directory) await visit(child);
          else if (type === vscode.FileType.File && (!extension || name.toLowerCase().endsWith(extension))) files.push(child.fsPath);
        }
      };
      await visit(directory);
      return files.sort((a, b) => a.localeCompare(b));
    };
    const relativeName = (file: string, directory: vscode.Uri, extension: string): string => {
      const base = directory.fsPath.replace(/[\\/]$/, "");
      return file.slice(base.length + 1).replace(/[\\/]/g, ".").replace(new RegExp(`${extension}$`, "i"), "");
    };
    const apiRoot = vscode.Uri.joinPath(root, "api");
    const ruleRoot = vscode.Uri.joinPath(root, "rules");
    const skillRoot = vscode.Uri.joinPath(root, "skills");
    const apis = (await listFiles(apiRoot, ".dx")).map((file) => ({ name: relativeName(file, apiRoot, ".dx") }));
    const rules = (await listFiles(ruleRoot, ".md")).map((file) => ({ name: relativeName(file, ruleRoot, ".md") }));
    const skills = (await listFiles(skillRoot, "skill.md")).map((file) => ({
      name: file.slice(skillRoot.fsPath.replace(/[\\/]$/, "").length + 1).replace(/[\\/]/g, "/").replace(/\/SKILL\.md$/i, "")
    }));
    const mcps: GlobalResourceItem[] = [];
    for (const file of await listFiles(vscode.Uri.joinPath(root, "mcp"), ".jsonc")) {
      try {
        const manifest = parseMcpManifest(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file))), file);
        if (manifest.server) mcps.push({
          name: manifest.server.name,
          detail: manifest.server.transport === "http"
            ? manifest.server.url
            : manifest.server.command
        });
      } catch {
        mcps.push({ name: file.split(/[\\/]/).pop()!.replace(/\.jsonc$/i, ""), detail: "invalid configuration" });
      }
    }
    return { apis, mcps: mcps.sort((a, b) => a.name.localeCompare(b.name)), rules, skills };
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
      agentTimeoutMs: positive("agent.timeoutMs", 3_600_000)
    });
    this.workflowRuntime.setMaxConcurrency(positive("workflow.maxConcurrency", DEFAULT_MAX_CONCURRENCY));
  }

  /** Project APIs are searched first, then global APIs; `dext.apiDirs` adds to
   * the shared roots. Relative entries resolve from the workspace, and the
   * project directory stays first so a global API cannot shadow it. */
  private apiDirectories(folder: vscode.WorkspaceFolder | undefined): string[] {
    const roots = folder ? [vscode.Uri.joinPath(folder.uri, ".dext", "api").fsPath] : [];
    roots.push(vscode.Uri.joinPath(this.storage.globalStorageUri, "api").fsPath);
    if (!folder) return roots;
    const configured = vscode.workspace.getConfiguration("dext").get<string[]>("apiDirs", []) ?? [];
    for (const entry of configured) {
      const value = typeof entry === "string" ? entry.trim() : "";
      if (!value) continue;
      const uri = isAbsolute(value) ? vscode.Uri.file(value) : vscode.Uri.joinPath(folder.uri, value);
      if (!roots.includes(uri.fsPath)) roots.push(uri.fsPath);
    }
    return roots;
  }

  /** Project and global MCP manifests use the same format. One file per server
   * keeps the allowlist and its API contract together rather than split across settings. */
  private async loadMcpManifests(folder: vscode.WorkspaceFolder | undefined, includeGlobal = true): Promise<{
    servers: McpServerConfig[];
    tools: McpToolConfig[];
    methods: CallableDefinition[];
    diagnostics: string[];
    projectDiagnostics: string[];
    globalDiagnostics: string[];
  }> {
    const directories: Array<{ uri: vscode.Uri; scope: "project" | "global" }> = [];
    if (folder?.uri.scheme === "file") directories.push({ uri: vscode.Uri.joinPath(folder.uri, ".dext", "mcp"), scope: "project" });
    if (includeGlobal) directories.push({ uri: vscode.Uri.joinPath(this.storage.globalStorageUri, "mcp"), scope: "global" });
    const servers: McpServerConfig[] = [];
    const tools: McpToolConfig[] = [];
    const methods: CallableDefinition[] = [];
    const diagnostics: string[] = [];
    const projectDiagnostics: string[] = [];
    const globalDiagnostics: string[] = [];
    const seenServerNames = new Set<string>();
    for (const { uri: directory, scope } of directories) {
      let entries: [string, vscode.FileType][];
      try { entries = await vscode.workspace.fs.readDirectory(directory); }
      catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") continue;
        const message = `MCP manifest discovery: ${error instanceof Error ? error.message : String(error)}`;
        diagnostics.push(message);
        (scope === "global" ? globalDiagnostics : projectDiagnostics).push(message);
        continue;
      }
      for (const [name, type] of entries.sort(([left], [right]) => left.localeCompare(right))) {
      if (type !== vscode.FileType.File || !name.toLowerCase().endsWith(".jsonc")) continue;
      const file = vscode.Uri.joinPath(directory, name);
      try {
        const manifest = parseMcpManifest(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)), file.fsPath);
        if (manifest.server && seenServerNames.has(manifest.server.name)) continue;
        if (manifest.server) {
          seenServerNames.add(manifest.server.name);
          servers.push({ ...manifest.server, scope });
        }
        tools.push(...manifest.tools);
        methods.push(...manifest.methods);
        diagnostics.push(...manifest.diagnostics);
        (scope === "global" ? globalDiagnostics : projectDiagnostics).push(...manifest.diagnostics);
      } catch (error) {
        const message = `${file.fsPath}: ${error instanceof Error ? error.message : String(error)}`;
        diagnostics.push(message);
        (scope === "global" ? globalDiagnostics : projectDiagnostics).push(message);
      }
      }
    }
    return { servers, tools, methods, diagnostics, projectDiagnostics, globalDiagnostics };
  }

  /** The permission default and the passthrough arguments are both settings, so
   * they are re-read whenever configuration changes rather than cached at
   * construction. */
  applyAgentPermissionSettings(): void {
    const configuration = vscode.workspace.getConfiguration("dext");
    const configured = configuration.get<string>("agentPermission", "workspace-write");
    this.runtime.setDefaultAgentPermission(
      AGENT_PERMISSIONS.includes(configured as WritableAgentPermission)
        ? configured as WritableAgentPermission
        : "workspace-write"
    );
    const raw = configuration.get<Record<string, unknown>>("agentCliArgs", {}) ?? {};
    const byProvider: Partial<Record<AgentProvider, readonly string[]>> = {};
    for (const provider of ["codex", "claude", "deepseek-harness"] as const) {
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
      mcpServers: this.mcp.listServers(),
      globalDiagnostics: this.globalDiagnostics,
      globalResources: this.globalResources,
      agentProfiles: this.agentProfiles(),
      agentSelection: this.agents.currentSelection(),
      settings: this.webviewSettings()
    };
  }

  /** Creates a project-owned MCP manifest. The server is verified and its
   * tools are discovered when possible, so the generated file is immediately
   * usable while keeping the explicit allowlist required by Dext. */
  async createMcpManifest(server: McpServerConfig, scope: "project" | "global" = "project", selectedTools?: readonly string[]): Promise<void> {
    if (!/^[A-Za-z0-9_.-]+$/.test(server.name)) {
      throw new Error("MCP server names must use letters, numbers, dots, underscores, or hyphens.");
    }
    if (server.transport === "http") {
      let url: URL;
      try { url = new URL(server.url); } catch { throw new Error("MCP HTTP URL is invalid."); }
      const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error("MCP HTTP URL must use HTTPS or loopback HTTP.");
      }
      if (url.username || url.password || url.search || url.hash) {
        throw new Error("MCP HTTP URL must not contain credentials, query strings, or fragments.");
      }
    } else if (!server.command.trim()) {
      throw new Error("MCP stdio command is required.");
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (scope === "project" && (!folder || folder.uri.scheme !== "file" || !this.workspaceTrusted)) {
      throw new Error("Creating an MCP configuration requires a trusted local workspace.");
    }
    const directory = scope === "global"
      ? vscode.Uri.joinPath(this.storage.globalStorageUri, "mcp")
      : vscode.Uri.joinPath(folder!.uri, ".dext", "mcp");
    await vscode.workspace.fs.createDirectory(directory);
    const file = vscode.Uri.joinPath(directory, `${server.name}.jsonc`);
    try {
      await vscode.workspace.fs.stat(file);
      throw new Error(`MCP configuration '${server.name}' already exists.`);
    } catch (error) {
      if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error;
    }
    const initial = { ...server, tools: [] };
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(`${JSON.stringify(initial, null, 2)}\n`));
    await this.reload();
    let tools: Array<Record<string, unknown>> = [];
    try {
      const discovered = await this.mcp.discoverServerTools(server.name);
      const selected = selectedTools === undefined ? discovered : discovered.filter((tool) => selectedTools.includes(tool.name));
      tools = selected.map((tool) => ({
        // Manifest tools are local allowlist entries.  The server is already
        // declared by the containing file, so the parser expects the MCP
        // protocol's tool name here (not the registry's flattened
        // `{server, tool}` representation).
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {})
      }));
    } catch {
      // Saving the server is still useful when discovery needs credentials or
      // the endpoint is temporarily unavailable; the user can edit/reload it.
    }
    const manifest = { ...server, tools };
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
    await this.reload();
  }

  async discoverMcpTools(server: McpServerConfig): Promise<McpDiscoveredTool[]> {
    return this.mcp.discoverTools(server);
  }

  /** Ask the currently selected Agent CLI to turn MCP documentation or a
   * natural-language description into a server manifest. */
  async generateMcpManifest(document: string, metadata: Readonly<ExecutionMetadata> = {}): Promise<McpServerConfig> {
    const trimmed = document.trim();
    let documentUrl: string | undefined;
    try {
      const url = new URL(trimmed);
      if (["http:", "https:"].includes(url.protocol)) documentUrl = trimmed;
    } catch {
      // Natural-language MCP descriptions are also accepted by create().
    }
    let documentation = "";
    if (documentUrl) {
      try {
        const fetched = await fetch(documentUrl, { signal: AbortSignal.timeout(15_000) });
        if (fetched.ok) documentation = (await fetched.text()).slice(0, 80_000);
      } catch {
        // The selected CLI may still be able to access the URL itself.
      }
    }
    const selection = this.agents.currentSelection();
    const response = await this.runtime.executeConversation("ask", [
      "You generate Dext MCP configuration.",
      "Read the MCP documentation or interpret the user's description and return exactly one JSON object, with no markdown fences or commentary.",
      "Allowed shape: {name, transport:'http', url, auth?:{type:'bearer'}, timeoutMs?} or {name, transport:'stdio', command, args?, auth?:{type:'token',env:'ENV_NAME'}, timeoutMs?}.",
      "Use the actual MCP endpoint or install command from the documentation; do not invent credentials.",
      documentUrl ? `Documentation URL: ${documentUrl}` : `User description: ${trimmed}`,
      documentation ? `Documentation content:\n${documentation}` : "No documentation was fetched; infer only what the URL or user description supports."
    ].join("\n"), {
      ...(selection.profileId ? { agent: selection.profileId } : {}),
      ...metadata
    });
    if (response.result.kind !== "chat") throw new Error("The selected Agent did not return text.");
    const raw = response.result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error("The Agent returned invalid JSON. Try again or paste a direct MCP configuration."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The Agent returned an invalid MCP configuration.");
    const candidate = value as Record<string, unknown>;
    if (candidate.transport === "http" && typeof candidate.name === "string" && typeof candidate.url === "string") {
      return {
        name: candidate.name, transport: "http", url: candidate.url,
        ...(candidate.auth && typeof candidate.auth === "object" ? { auth: { type: "bearer" as const } } : {}),
        ...(typeof candidate.timeoutMs === "number" ? { timeoutMs: candidate.timeoutMs } : {})
      };
    }
    if (candidate.transport === "stdio" && typeof candidate.name === "string" && typeof candidate.command === "string") {
      const args = Array.isArray(candidate.args) ? candidate.args.filter((item): item is string => typeof item === "string") : undefined;
      const auth = candidate.auth && typeof candidate.auth === "object" && !Array.isArray(candidate.auth)
        ? candidate.auth as Record<string, unknown>
        : undefined;
      const stdioAuth = auth?.type === "token" && typeof auth.env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.env)
        ? { type: "token" as const, env: auth.env }
        : undefined;
      return {
        name: candidate.name,
        transport: "stdio",
        command: candidate.command,
        ...(args?.length ? { args } : {}),
        ...(stdioAuth ? { auth: stdioAuth } : {}),
        ...(typeof candidate.timeoutMs === "number" ? { timeoutMs: candidate.timeoutMs } : {})
      };
    }
    throw new Error("The Agent returned an unsupported MCP configuration shape.");
  }

  private async createResource(args: Record<string, unknown>, metadata: Readonly<ExecutionMetadata>): Promise<DextResult> {
    const type = args.type;
    const input = args.input;
    const scope = args.scope === "global" ? "global" : "project";
    if (!["api", "mcp", "rule", "skill"].includes(String(type))) throw new Error("create type must be 'api', 'mcp', 'rule', or 'skill'.");
    if (typeof input !== "string" || !input.trim()) throw new Error("create input must be a non-empty string.");
    if (scope === "project" && !this.workspaceTrusted) throw new Error("Project resource creation requires a trusted local workspace.");
    if (type === "mcp") {
      const server = await this.generateMcpManifest(input, metadata);
      await this.createMcpManifest(server, scope);
      return { kind: "chat", text: `Created MCP configuration '${server.name}' (${scope}).` };
    }
    const response = await this.runtime.executeConversation("ask", [
      type === "api" ? "Generate one Dext custom API file." : type === "rule" ? "Generate one Dext rule markdown file." : "Generate one Dext SKILL.md package.",
      "Return exactly one JSON object with fields name and content, with no markdown fences or commentary.",
      type === "api"
        ? "name must be a dotted API id using letters, numbers, underscores, and dots; content must be valid Dext .dx containing def main(...)."
        : type === "rule"
          ? "name must be a safe markdown filename without path separators; content must be concise policy markdown."
          : "name must be a safe skill directory name without path separators; content must be a complete SKILL.md.",
      "The resource should implement this request:", input.trim()
    ].join("\n"), metadata);
    if (response.result.kind !== "chat") throw new Error("The selected Agent did not return resource text.");
    let value: unknown;
    try { value = JSON.parse(response.result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()); }
    catch { throw new Error("The Agent returned invalid resource JSON."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The Agent returned an invalid resource object.");
    const candidate = value as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
    if (type === "api") {
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(name) || !content.includes("def main")) throw new Error("The Agent returned an unsupported API shape.");
      const compiled = compileWorkflow(content, this.registry, { allowImports: true, aliases: parseWorkflowImports(content), customApiIds: this.customApiIds, requireCustomApiImports: false });
      if (!compiled.program || compiled.diagnostics.some((item) => item.severity === "error")) throw new Error(`The Agent returned invalid Dext API source: ${compiled.diagnostics.map((item) => item.message).join("\\n")}`);
    } else if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || !content) throw new Error("The Agent returned an unsupported resource shape.");
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (scope === "project" && (!folder || folder.uri.scheme !== "file")) throw new Error("Project resources require a local workspace.");
    const root = scope === "global"
      ? vscode.Uri.joinPath(this.storage.globalStorageUri, type === "api" ? "api" : type === "rule" ? "rules" : "skills")
      : vscode.Uri.joinPath(folder!.uri, ".dext", type === "api" ? "api" : type === "rule" ? "rules" : "skills");
    const segments = type === "api" ? name.split(".") : [name];
    const fileName = segments.pop()!;
    const directory = vscode.Uri.joinPath(root, ...segments, ...(type === "skill" ? [fileName] : []));
    const file = vscode.Uri.joinPath(directory, type === "skill" ? "SKILL.md" : `${fileName}${type === "rule" ? ".md" : ".dx"}`);
    try { await vscode.workspace.fs.stat(file); throw new Error(`${String(type)} '${name}' already exists.`); }
    catch (error) { if (!(error instanceof vscode.FileSystemError && error.code === "FileNotFound")) throw error; }
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(`${content}\n`));
    await this.reload();
    return { kind: "chat", text: `Created ${String(type)} '${name}' (${scope}).` };
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

  /** Profiles exposed to the composer. */
  agentProfiles(): AgentProfile[] {
    const configured = vscode.workspace.getConfiguration("dext").get<unknown>("agentCli", ["codex", "claude", "deepseek-harness"]);
    const ids = Array.isArray(configured)
      ? [...new Set(configured
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim()))]
      : [];
    const enabledIds = ids.filter((id) => (SUPPORTED_AGENT_PROFILE_IDS as readonly string[]).includes(id));
    const selectedIds = enabledIds.length ? enabledIds : ["codex", "claude", "deepseek-harness"];
    return this.agents.list(selectedIds);
  }

  /** Returns non-empty profile IDs that cannot be used by `dext.agentCli`. */
  invalidAgentCliIds(): string[] {
    const configured = vscode.workspace.getConfiguration("dext").get<unknown>("agentCli", ["codex", "claude", "deepseek-harness"]);
    if (!Array.isArray(configured)) return [];
    return [...new Set(configured
      .filter((item): item is string => typeof item === "string" && item.trim() !== "")
      .map((item) => item.trim())
      .filter((id) => !(SUPPORTED_AGENT_PROFILE_IDS as readonly string[]).includes(id)))];
  }

  refreshAgentProfiles(): void {
    const profiles = this.agentProfiles();
    this.runtime.setAgentProfiles(profiles);
    const selection = this.agents.currentSelection();
    if (selection.profileId && !profiles.some((profile) => profile.id === selection.profileId)) {
      const fallback = profiles[0];
      if (fallback) {
        const next = { ...selection, profileId: fallback.id, model: "", reasoningEffort: "", speed: "", serviceTier: "" };
        this.agents.setSelection(next);
        this.runtime.setAgentSelection(next);
      }
    }
  }

  updateAgentProfile(profile: AgentProfile): void {
    this.agents.update(profile);
    this.refreshAgentProfiles();
  }

  dispose(): Promise<void> {
    return this.agentRunner.dispose();
  }

  async discoverHarnessModels(): Promise<void> {
    const profile = this.agents.list().find((item) => item.provider === "deepseek-harness");
    if (!profile) return;
    const args = this.workspaceTrusted
      ? vscode.workspace.getConfiguration("dext").get<Record<string, string[]>>("agentCliArgs", {})["deepseek-harness"] ?? []
      : [];
    const modelOptions = await this.agentRunner.harness.discoverModels(profile, this.workspaceRoot, args);
    this.updateAgentProfile({ ...profile, models: modelOptions.map((item) => item.id), modelOptions });
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
    let prompt = this.storage.attachmentPrompt(input);
    if (mode === "plan" && metadata.planPath && !metadata.executePlan) {
      const target = this.planUri(metadata.planPath);
      if (!target) throw new Error(`Plan '${metadata.planPath}' is no longer available.`);
      let current: string;
      try {
        current = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
      } catch {
        throw new Error(`Plan '${metadata.planPath}' is no longer available.`);
      }
      prompt = [
        "Revise the selected plan document according to the user's request.",
        "Keep the plan complete and internally consistent after applying the requested changes.",
        "",
        "Current plan document:",
        "---",
        current.trim(),
        "---",
        "",
        "Requested changes:",
        prompt
      ].join("\n");
    }
    const response = await this.runtime.executeConversation(mode, prompt, metadata);
    const saved = mode === "plan" && !metadata.executePlan
      ? await this.savePlan(input, response, metadata.planPath)
      : response;
    return {
      kind: "workflow",
      executions: [saved],
      steps: [{ method: saved.method.id, state: "success", response: saved }]
    };
  }

  /** A plan is only useful if it survives the turn. The model's document goes
   * to the configured storage location, while its concise explanation remains
   * in the chat beside the file reference. */
  private async savePlan(input: string, response: InputExecutionResponse["executions"][number], existingPath?: string): Promise<InputExecutionResponse["executions"][number]> {
    const result = response.result;
    if (result.kind !== "chat" || !result.text.trim()) return response;
    const plan = splitPlanResponse(result.text);
    if (!plan.document) return response;
    const workspaceStorage = this.storage.location() === "workspace";
    if (workspaceStorage && (!this.workspaceTrusted || !this.workspaceUri)) return response;
    const configured = vscode.workspace.getConfiguration("dext").get<string>("plan.directory", DEFAULT_PLAN_DIRECTORY).trim();
    const segments = workspaceStorage ? planPathSegments(configured || DEFAULT_PLAN_DIRECTORY) : [];
    const directory = workspaceStorage
      ? vscode.Uri.joinPath(this.workspaceUri!, ...segments)
      : this.storage.directory("plans");
    const name = existingPath ? undefined : planFileName(input, new Date());
    const target = existingPath
      ? this.planUri(existingPath) ?? vscode.Uri.joinPath(directory, ...planPathSegments(existingPath))
      : vscode.Uri.joinPath(directory, name!);
    await vscode.workspace.fs.createDirectory(directory);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(`${plan.document}\n`));
    const planPath = existingPath ?? (workspaceStorage ? [...segments, name!].join("/") : this.storage.reference("plans", name!));
    return { ...response, result: { ...result, text: plan.conversation, planPath } };
  }

  planUri(reference: string): vscode.Uri | undefined {
    return this.storage.uriForReference("plans", reference);
  }

  endAgentSession(sessionId: string): void {
    this.runtime.endAgentSession(sessionId);
  }

  isTrustedLocalWorkspace(): boolean {
    return this.workspaceTrusted;
  }

  mcpCredentialServers(transport?: "http" | "stdio"): McpServerConfig[] {
    return this.mcp.listServers().filter((server) => {
      if (!server.auth || (transport && server.transport !== transport)) return false;
      return true;
    });
  }

  async setMcpAccessToken(serverName: string, token: string): Promise<void> {
    const server = this.assertCredentialServer(serverName);
    if (!this.mcpSecrets) throw new Error("VS Code SecretStorage is not available.");
    await this.mcpSecrets.store(
      serverName,
      token,
      server.scope === "global" ? "global" : "workspace",
      server.transport === "http" ? "bearer" : "token"
    );
  }

  /** Discovers the authenticated server's tools and updates its manifest's
   * explicit allowlist while preserving JSONC comments and formatting. */
  async discoverAndPersistMcpTools(serverName: string): Promise<number> {
    const server = this.assertCredentialServer(serverName);
    const discovered = await this.mcp.discoverServerTools(serverName);
    const folder = vscode.workspace.workspaceFolders?.[0];
    const directories: Array<{ uri: vscode.Uri; scope: "project" | "global" }> = [];
    if (folder?.uri.scheme === "file") directories.push({ uri: vscode.Uri.joinPath(folder.uri, ".dext", "mcp"), scope: "project" });
    directories.push({ uri: vscode.Uri.joinPath(this.storage.globalStorageUri, "mcp"), scope: "global" });
    for (const { uri: directory, scope } of directories) {
      if (server.scope && server.scope !== scope) continue;
      let entries: [string, vscode.FileType][];
      try { entries = await vscode.workspace.fs.readDirectory(directory); }
      catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") continue;
        throw error;
      }
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.toLowerCase().endsWith(".jsonc")) continue;
        const file = vscode.Uri.joinPath(directory, name);
        const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
        const parsed = parseMcpManifest(source, file.fsPath);
        if (parsed.server?.name !== serverName) continue;
        const tools = discovered.map((tool) => {
          // Some MCP servers (including older Teambition package versions)
          // omit outputSchema from tools/list. Keep a schema authored in the
          // manifest so rediscovery does not silently disable result hints.
          const existing = parsed.tools.find((candidate) => candidate.tool === tool.name);
          return {
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.outputSchema ?? existing?.outputSchema
              ? { outputSchema: tool.outputSchema ?? existing?.outputSchema } : {})
          };
        });
        const edits = modify(source, ["tools"], tools, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
        await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(applyEdits(source, edits)));
        await this.reload();
        return tools.length;
      }
    }
    throw new Error(`MCP manifest for '${serverName}' could not be found.`);
  }

  async clearMcpAccessToken(serverName: string): Promise<void> {
    const server = this.assertCredentialServer(serverName);
    if (!this.mcpSecrets) throw new Error("VS Code SecretStorage is not available.");
    await this.mcpSecrets.delete(
      serverName,
      server.scope === "global" ? "global" : "workspace",
      server.transport === "http" ? "bearer" : "token"
    );
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

  private assertCredentialServer(serverName: string): McpServerConfig {
    if (!this.workspaceTrusted) throw new Error("MCP credentials require a trusted local workspace.");
    const server = this.mcp.getServer(serverName);
    if (!server?.auth) throw new Error(`MCP server '${serverName}' does not declare a token credential.`);
    return server;
  }
}
