/** A stable credential kind for a manifest-configured MCP server. */
export type McpCredentialKind = "bearer" | "token" | "query";

export interface StdioMcpServerConfig {
  name: string;
  transport: "stdio";
  command: string;
  args?: string[];
  /** Inject a SecretStorage token into the named child-process environment variable. */
  auth?: { type: "token"; env: string };
  /** Set by Dext when loading a project/global manifest; not persisted by the manifest writer. */
  scope?: "project" | "global";
  timeoutMs?: number;
}

export interface HttpQueryAuth {
  type: "query";
  /** Query parameter name the SecretStorage token is attached under at request time. */
  name: string;
}

export interface HttpMcpServerConfig {
  name: string;
  transport: "http";
  url: string;
  auth?: { type: "bearer" } | HttpQueryAuth;
  /** Set by Dext when loading a project/global manifest; not persisted by the manifest writer. */
  scope?: "project" | "global";
  timeoutMs?: number;
}

export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig;

export interface McpToolConfig {
  server: string;
  tool: string;
  /** MCP is the default; REST tools are executed by Dext's generic adapter. */
  kind?: "mcp" | "rest";
  method?: string;
  url?: string;
  /** Optional human-facing API documentation link. */
  docsUrl?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}
