import { createHash } from "node:crypto";

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export type McpCredentialKind = "bearer" | "token";
export type McpCredentialScope = "workspace" | "global";

/** MCP credentials stay in VS Code's encrypted SecretStorage. The key records
 * server, credential kind, and either workspace or global manifest scope. */
export class McpAccessTokenStore {
  constructor(
    private readonly secrets: SecretStorageLike,
    private readonly workspaceScope: () => string | undefined
  ) {}

  async get(serverName: string, scope: McpCredentialScope = "workspace", kind: McpCredentialKind = "bearer"): Promise<string | undefined> {
    return this.secrets.get(this.key(serverName, scope, kind));
  }

  async store(serverName: string, token: string, scope: McpCredentialScope = "workspace", kind: McpCredentialKind = "bearer"): Promise<void> {
    if (!token.trim()) throw new Error("MCP access tokens cannot be empty.");
    await this.secrets.store(this.key(serverName, scope, kind), token);
  }

  async delete(serverName: string, scope: McpCredentialScope = "workspace", kind: McpCredentialKind = "bearer"): Promise<void> {
    await this.secrets.delete(this.key(serverName, scope, kind));
  }

  private key(serverName: string, scope: McpCredentialScope, kind: McpCredentialKind): string {
    const workspace = this.workspaceScope();
    if (scope === "workspace") {
      if (!workspace) throw new Error("A local workspace is required to access MCP credentials.");
      const digest = createHash("sha256").update(`${workspace}\u0000${serverName}`).digest("hex");
      return `dext.mcp.${kind}.${digest}`;
    }
    const digest = createHash("sha256").update(serverName).digest("hex");
    return `dext.mcp.${kind}.global.${digest}`;
  }
}
