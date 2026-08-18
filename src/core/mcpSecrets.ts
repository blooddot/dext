import { createHash } from "node:crypto";

export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

/** Workspace-scoped MCP bearer credentials. The configuration only references
 * the authentication scheme; values stay in VS Code's encrypted secret store. */
export class McpAccessTokenStore {
  constructor(
    private readonly secrets: SecretStorageLike,
    private readonly workspaceScope: () => string | undefined
  ) {}

  async get(serverName: string): Promise<string | undefined> {
    return this.secrets.get(this.key(serverName));
  }

  async store(serverName: string, token: string): Promise<void> {
    if (!token.trim()) throw new Error("MCP access tokens cannot be empty.");
    await this.secrets.store(this.key(serverName), token);
  }

  async delete(serverName: string): Promise<void> {
    await this.secrets.delete(this.key(serverName));
  }

  private key(serverName: string): string {
    const workspace = this.workspaceScope();
    if (!workspace) throw new Error("A local workspace is required to access MCP credentials.");
    const scope = createHash("sha256").update(`${workspace}\u0000${serverName}`).digest("hex");
    return `dext.mcp.bearer.${scope}`;
  }
}
