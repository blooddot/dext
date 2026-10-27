import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_MCP_IMAGE_BYTES, McpImageCache, type McpImageCacheOptions } from "../src/features/mcp/host/mcpImageCache.js";
import { McpToolRegistry, type McpTransport } from "../src/features/mcp/host/mcpRegistry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dext-mcp-image-"));
  roots.push(root);
  return root;
}

async function imageCache(options: Partial<McpImageCacheOptions> = {}): Promise<McpImageCache> {
  return new McpImageCache({
    directory: join(await tempRoot(), "mcp-media"),
    toUrl: (filePath) => `https://file+.vscode-resource.vscode-cdn.net/${encodeURIComponent(basename(filePath))}`,
    ...options
  });
}

async function cacheFiles(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, "mcp-media"));
  } catch {
    return [];
  }
}

function registryWith(transport: McpTransport, cache?: McpImageCache): McpToolRegistry {
  const registry = new McpToolRegistry(transport);
  registry.setServers([{ name: "xiaocui", transport: "stdio", command: "fake-mcp" }]);
  registry.setTools([{ server: "xiaocui", tool: "media_image" }]);
  if (cache) registry.setImageCache(cache);
  return registry;
}

describe("MCP image results", () => {
  it("keeps text and caches an image block behind a Webview URL", async () => {
    const root = await tempRoot();
    const cache = await imageCache({ directory: join(root, "mcp-media") });
    const bytes = Buffer.from("not-really-a-png");
    const registry = registryWith({
      call: async () => ({
        content: "before\nafter",
        images: [{ data: bytes.toString("base64"), mimeType: "image/png" }]
      })
    }, cache);

    const result = await registry.call("xiaocui.media_image", {});
    expect(result).toMatchObject({
      kind: "mcpRaw",
      content: "before\nafter",
      images: [{ mimeType: "image/png", byteLength: bytes.byteLength }]
    });
    expect(result.imageError).toBeUndefined();
    expect(result.images?.[0]?.url).toMatch(/^https:\/\/file\+\.vscode-resource\.vscode-cdn\.net\/[0-9a-f-]{36}\.png$/);
    const files = await cacheFiles(root);
    expect(files).toHaveLength(1);
    expect(await readFile(join(root, "mcp-media", files[0]!))).toEqual(bytes);
    expect(result.images?.[0]?.url).toContain(files[0]!);
  });

  it("returns an image-only result without inventing text or structured content", async () => {
    const cache = await imageCache();
    const registry = registryWith({
      call: async () => ({
        images: [{ data: Buffer.from("gif").toString("base64"), mimeType: "image/gif" }]
      })
    }, cache);

    const result = await registry.call("xiaocui.media_image", {});
    expect(result.content).toBeUndefined();
    expect(result.structured).toBeUndefined();
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0]?.mimeType).toBe("image/gif");
    expect(result.images?.[0]?.url).toMatch(/^https:\/\//);
  });

  it("skips SVG/HTML while keeping the rest of the result intact", async () => {
    const root = await tempRoot();
    const cache = await imageCache({ directory: join(root, "mcp-media") });
    const text = "caption";
    const registry = registryWith({
      call: async () => ({
        content: text,
        structuredContent: { id: 7 },
        images: [
          { data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" },
          { data: Buffer.from("<html/>").toString("base64"), mimeType: "text/html" }
        ]
      })
    }, cache);

    const result = await registry.call("xiaocui.media_image", {});
    expect(result.content).toBe(text);
    expect(result.structured).toEqual({ id: 7 });
    expect(result.images).toBeUndefined();
    expect(result.imageError).toContain("unsupported image type");
    expect(await cacheFiles(root)).toHaveLength(0);
  });

  it("rejects an image over 10 MiB without failing the tool call", async () => {
    const root = await tempRoot();
    const cache = await imageCache({ directory: join(root, "mcp-media") });
    const oversized = Buffer.alloc(MAX_MCP_IMAGE_BYTES + 1).toString("base64");
    const registry = registryWith({
      call: async () => ({
        content: "too large",
        images: [{ data: oversized, mimeType: "image/jpeg" }]
      })
    }, cache);

    const result = await registry.call("xiaocui.media_image", {});
    expect(result.content).toBe("too large");
    expect(result.images).toBeUndefined();
    expect(result.imageError).toContain(String(MAX_MCP_IMAGE_BYTES));
    expect(await cacheFiles(root)).toHaveLength(0);
  });

  it("keeps the exact pre-image result shape when the server returns no image", async () => {
    const cache = await imageCache();
    const registry = registryWith({
      call: async () => ({ content: "ok", structuredContent: { ready: true } })
    }, cache);

    await expect(registry.call("xiaocui.media_image", {})).resolves.toEqual({
      kind: "mcpRaw",
      server: "xiaocui",
      tool: "media_image",
      content: "ok",
      structured: { ready: true }
    });
  });

  it("reports a URL failure and removes the orphaned file", async () => {
    const root = await tempRoot();
    const cache = await imageCache({ directory: join(root, "mcp-media"), toUrl: () => undefined });
    const registry = registryWith({
      call: async () => ({ images: [{ data: Buffer.from("png").toString("base64"), mimeType: "image/webp" }] })
    }, cache);

    const result = await registry.call("xiaocui.media_image", {});
    expect(result.images).toBeUndefined();
    expect(result.imageError).toContain("no Webview URL");
    expect(await cacheFiles(root)).toHaveLength(0);
  });
});

describe("McpImageCache lifecycle", () => {
  async function cacheAt(root: string, options: Partial<McpImageCacheOptions> = {}): Promise<McpImageCache> {
    return new McpImageCache({
      directory: join(root, "mcp-media"),
      toUrl: (filePath) => `https://webview.test/${basename(filePath)}`,
      ...options
    });
  }

  it("expires files from earlier sessions but keeps the image just written", async () => {
    const root = await tempRoot();
    const directory = join(root, "mcp-media");
    await mkdir(directory, { recursive: true });
    const cache = await cacheAt(root, { now: () => 30 * 24 * 60 * 60 * 1000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    const old = join(directory, `${randomUUID()}.png`);
    await writeFile(old, Buffer.from("old"));
    await utimes(old, 0, 0);

    await cache.store([{ data: Buffer.from("new").toString("base64"), mimeType: "image/png" }], "test");
    const files = await cacheFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}\.png$/);
  });

  it("evicts the oldest earlier-session file when the total budget is exceeded", async () => {
    const root = await tempRoot();
    const directory = join(root, "mcp-media");
    await mkdir(directory, { recursive: true });
    const now = Date.now();
    const cache = await cacheAt(root, { now: () => now, maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxTotalBytes: 4 });
    for (const ageMs of [2 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]) {
      const file = join(directory, `${randomUUID()}.png`);
      await writeFile(file, Buffer.from("old"));
      await utimes(file, new Date(now - ageMs), new Date(now - ageMs));
    }

    await cache.store([{ data: Buffer.from("new").toString("base64"), mimeType: "image/png" }], "test");
    const files = await cacheFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}\.png$/);
  });
});
