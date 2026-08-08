import { describe, expect, it } from "vitest";
import { ContextResolver, type ContextHost } from "../src/core/contextResolver.js";

const host: ContextHost = {
  selection: async () => ({
    uri: "file:///src/a.ts",
    content: "const a = 1;",
    version: 4,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } }
  }),
  activeFile: async () => undefined,
  file: async (path) => ({ uri: `file:///${path}`, content: path, version: 1 }),
  symbol: async (name) => ({ uri: "file:///src/a.ts", content: `class ${name} {}`, version: 4, symbol: name })
};

describe("ContextResolver", () => {
  it("creates immutable code snapshots with a content hash", async () => {
    const result = await new ContextResolver(host).resolveReference({ kind: "selection" });
    expect(result).toMatchObject({
      kind: "codeRef",
      uri: "file:///src/a.ts",
      documentVersion: 4,
      content: "const a = 1;"
    });
    expect(result.contentHash).toHaveLength(64);
  });

  it("resolves file and symbol arguments", async () => {
    const resolver = new ContextResolver(host);
    await expect(resolver.resolveReference({ kind: "file", path: "src/b.ts" }))
      .resolves.toMatchObject({ uri: "file:///src/b.ts" });
    await expect(resolver.resolveReference({ kind: "symbol", name: "User" }))
      .resolves.toMatchObject({ symbol: "User" });
  });
});
