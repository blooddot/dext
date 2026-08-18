import { describe, expect, it } from "vitest";
import { McpAccessTokenStore, type SecretStorageLike } from "../src/core/mcpSecrets.js";

describe("McpAccessTokenStore", () => {
  it("derives distinct opaque SecretStorage keys for each workspace and server", async () => {
    const requested: string[] = [];
    const secrets: SecretStorageLike = {
      get: async (key) => {
        requested.push(key);
        return undefined;
      },
      store: async () => {},
      delete: async () => {}
    };
    const first = new McpAccessTokenStore(secrets, () => "file:///workspace-one");
    const second = new McpAccessTokenStore(secrets, () => "file:///workspace-two");

    await first.get("remote");
    await second.get("remote");

    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toEqual(requested[1]);
    expect(requested.every((key) => /^dext\.mcp\.bearer\.[a-f0-9]{64}$/.test(key))).toBe(true);
  });

  it("does not access SecretStorage without a local workspace and rejects empty credentials", async () => {
    const secrets: SecretStorageLike = {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {}
    };
    const missingWorkspace = new McpAccessTokenStore(secrets, () => undefined);
    const workspace = new McpAccessTokenStore(secrets, () => "file:///workspace");

    await expect(missingWorkspace.get("remote")).rejects.toThrow("local workspace");
    await expect(workspace.store("remote", "")).rejects.toThrow("cannot be empty");
  });
});
