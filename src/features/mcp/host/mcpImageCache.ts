import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The image block Dext keeps from an MCP tools/call result. */
export interface McpImageContent {
  data: string;
  mimeType: string;
}

export interface McpCachedImage {
  mimeType: string;
  url: string;
  byteLength: number;
}

export interface McpImageStoreResult {
  images: McpCachedImage[];
  diagnostics: string[];
}

export interface McpImageCacheOptions {
  directory: string;
  /** Translates a cached file into a URL the Webview may load. */
  toUrl: (filePath: string) => string | undefined;
  now?: () => number;
  maxTotalBytes?: number;
  maxAgeMs?: number;
}

export const MAX_MCP_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE = /^[0-9a-f-]{36}\.(?:png|jpg|gif|webp)$/i;
const MIME_EXTENSION = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"]
]);

/**
 * Stores MCP image blocks outside the Webview's realm so a token never travels
 * with the URL. Files are written once per call, named by a random UUID and
 * served for as long as the Webview resource root keeps them.
 *
 * A short TTL is deliberately not applied to files written by this process: an
 * MCP call can wait on a confirmation card for far longer than any age cut-off.
 * TTL and total-size pruning therefore only reclaim files left by earlier
 * sessions.
 */
export class McpImageCache {
  private readonly written = new Set<string>();
  private readonly now: () => number;
  private readonly maxTotalBytes: number;
  private readonly maxAgeMs: number;

  constructor(private readonly options: McpImageCacheOptions) {
    this.now = options.now ?? Date.now;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  async store(blocks: readonly McpImageContent[], label: string): Promise<McpImageStoreResult> {
    await this.prune();
    const images: McpCachedImage[] = [];
    const diagnostics: string[] = [];
    for (const block of blocks) {
      try {
        images.push(await this.write(block));
      } catch (error) {
        diagnostics.push(`${label} image skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // The write may have pushed an earlier session over the total budget.
    await this.prune();
    return { images, diagnostics };
  }

  private async write(block: McpImageContent): Promise<McpCachedImage> {
    const mimeType = block.mimeType.toLowerCase().split(";")[0]!.trim();
    const extension = MIME_EXTENSION.get(mimeType);
    if (!extension) {
      throw new Error(`unsupported image type '${block.mimeType}'. Allowed: ${[...MIME_EXTENSION.keys()].join(", ")}.`);
    }
    const data = block.data.replace(/\s+/g, "");
    if (!data) throw new Error("the image block has no data.");
    // Refuse the oversized payload before decoding it into a second copy.
    if (data.length > Math.ceil(MAX_MCP_IMAGE_BYTES * 4 / 3) + 4) {
      throw new Error(`image exceeds the ${MAX_MCP_IMAGE_BYTES} byte limit.`);
    }
    const bytes = Buffer.from(data, "base64");
    if (!bytes.byteLength) throw new Error("the image block is not valid base64.");
    if (bytes.byteLength > MAX_MCP_IMAGE_BYTES) {
      throw new Error(`image exceeds the ${MAX_MCP_IMAGE_BYTES} byte limit.`);
    }
    await mkdir(this.options.directory, { recursive: true });
    // The server's own file name (when it has one) is never used.
    const name = `${randomUUID()}${extension}`;
    const filePath = join(this.options.directory, name);
    await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    this.written.add(name);
    let url: string | undefined;
    try {
      url = this.options.toUrl(filePath);
    } catch {
      url = undefined;
    }
    if (!url || !/^https:\/\//i.test(url)) {
      this.written.delete(name);
      await rm(filePath, { force: true });
      throw new Error("the cached image has no Webview URL.");
    }
    return { mimeType, url, byteLength: bytes.byteLength };
  }

  /** Reclaim files from earlier sessions, oldest first. Current-session files
   * are protected so a long-running confirmation cannot lose its image. */
  private async prune(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.directory);
    } catch {
      return;
    }
    const now = this.now();
    const files: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      if (!CACHE_FILE.test(name)) continue;
      const path = join(this.options.directory, name);
      try {
        const info = await stat(path);
        files.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // A file removed between readdir and stat is already gone.
      }
    }
    const removable = files.filter((file) => !this.written.has(file.name));
    const expired = removable.filter((file) => now - file.mtimeMs > this.maxAgeMs);
    for (const file of expired) await rm(file.path, { force: true });
    const kept = files.filter((file) => !expired.includes(file));
    let total = kept.reduce((sum, file) => sum + file.size, 0);
    const candidates = removable.filter((file) => !expired.includes(file)).sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of candidates) {
      if (total <= this.maxTotalBytes) break;
      await rm(file.path, { force: true });
      total -= file.size;
    }
  }
}
