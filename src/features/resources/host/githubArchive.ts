import { gunzipSync } from "node:zlib";
import type { GithubSource } from "../domain/skillSource.js";

/** Archive limits chosen so a hostile repository cannot exhaust the extension
 * host. All values are bytes unless the name says otherwise. */
export interface ArchiveLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxFiles: number;
  timeoutMs: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 25 * 1024 * 1024,
  maxFiles: 5_000,
  timeoutMs: 20_000
};

export interface ExtractedArchive {
  files: Map<string, Uint8Array>;
  /** The `repo-commit` directory GitHub wraps the archive in. */
  root?: string;
  commit?: string;
}

export interface FetchedArchive extends ExtractedArchive {
  source: GithubSource;
  ref: string;
}

export interface FetchArchiveOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  limits?: Partial<ArchiveLimits>;
  apiBase?: string;
  codeloadBase?: string;
}

const ALLOWED_REDIRECT_HOSTS = new Set([
  "codeload.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com"
]);

function allowedRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && (ALLOWED_REDIRECT_HOSTS.has(url.hostname.toLowerCase()) || url.hostname.toLowerCase().endsWith(".githubusercontent.com"));
  } catch {
    return false;
  }
}

function field(block: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(start, end)).replace(/[\s\0]+$/, "");
}

function octal(block: Uint8Array, start: number, length: number): number {
  const text = field(block, start, length).trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("Invalid tar header number.");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid tar header number.");
  return value;
}

function normalizePath(raw: string, directory = false): string {
  const value = directory ? raw.replace(/\/+$/, "") : raw;
  if (!value || value.includes("\0") || value.includes("\\")) throw new Error("Invalid tar entry path.");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /^[A-Za-z]:/.test(segment))) {
    throw new Error(`Unsafe tar entry path: ${raw}`);
  }
  return segments.join("/");
}

function checksum(block: Uint8Array): number {
  let total = 0;
  for (let index = 0; index < block.length; index++) total += index >= 148 && index < 156 ? 0x20 : block[index]!;
  return total;
}

function paxRecords(data: Uint8Array): Map<string, string> {
  const result = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < data.length) {
    let space = offset;
    while (space < data.length && data[space] !== 0x20) space++;
    if (space >= data.length) throw new Error("Invalid pax header.");
    const length = Number.parseInt(decoder.decode(data.subarray(offset, space)), 10);
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) throw new Error("Invalid pax header.");
    const record = decoder.decode(data.subarray(space + 1, offset + length)).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals > 0) result.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return result;
}

/** Pure in-memory tar reader. It accepts the ustar, PAX and GNU long-name
 * forms GitHub emits and rejects everything a filesystem write must never see. */
export function extractTarGz(archive: Uint8Array, options: Partial<ArchiveLimits> = {}): ExtractedArchive {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options };
  let tar: Uint8Array;
  try {
    tar = gunzipSync(archive, { maxOutputLength: limits.maxExpandedBytes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes("maxOutputLength") || message.includes("Cannot create a Buffer larger")
      ? `The GitHub archive expands beyond ${limits.maxExpandedBytes} bytes.`
      : `Unable to decompress the GitHub archive: ${message}`);
  }
  const files = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  let root: string | undefined;
  let offset = 0;
  let longName: string | undefined;
  let pax: Map<string, string> | undefined;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expected = octal(header, 148, 8);
    if (expected !== checksum(header)) throw new Error("Invalid tar header checksum.");
    const type = String.fromCharCode(header[156] ?? 0);
    const size = (pax?.get("size") ? Number.parseInt(pax.get("size")!, 10) : octal(header, 124, 12));
    if (!Number.isInteger(size) || size < 0) throw new Error("Invalid tar entry size.");
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error("Truncated tar archive.");
    const data = tar.subarray(start, end);
    const next = (): number => end + ((512 - (size % 512)) % 512);
    const prefix = field(header, 345, 155);
    const headerName = longName ?? pax?.get("path") ?? field(header, 0, 100);
    const name = prefix ? `${prefix}/${headerName}` : headerName;

    if (type === "x" || type === "X") {
      pax = paxRecords(data);
      offset = next();
      continue;
    }
    if (type === "g") {
      // Global defaults are parsed only so their presence is validated; a
      // repository archive should not need them to interpret paths.
      paxRecords(data);
      offset = next();
      continue;
    }
    if (type === "L") {
      longName = new TextDecoder().decode(data).replace(/\0+$/, "");
      offset = next();
      continue;
    }
    if (type === "K") {
      throw new Error("Tar hard-link names are not supported.");
    }
    if (type === "1" || type === "2") {
      throw new Error("The GitHub archive contains a link, which cannot be imported safely.");
    }
    if (type === "3" || type === "4" || type === "6") {
      throw new Error("The GitHub archive contains a device or FIFO entry.");
    }
    if (type !== "0" && type !== "\0" && type !== "5" && type !== "7") {
      throw new Error(`Unsupported tar entry type '${type}'.`);
    }
    const path = normalizePath(name, type === "5");
    const segments = path.split("/");
    if (type === "5") {
      // Directory entries are redundant: every file below them is checked on
      // its own path. GitHub archives include them; they must not be mistaken
      // for a repository root file.
      pax = undefined;
      longName = undefined;
      offset = next();
      continue;
    }
    if (segments.length < 2) throw new Error("The GitHub archive has no repository root.");
    const archiveRoot = segments[0]!;
    if (root && archiveRoot !== root) throw new Error("The GitHub archive contains more than one repository root.");
    root ??= archiveRoot;
    const relative = segments.slice(1).join("/");
    const key = relative.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate tar entry: ${relative}`);
    seen.add(key);
    if (files.size >= limits.maxFiles) throw new Error(`The GitHub archive has more than ${limits.maxFiles} files.`);
    files.set(relative, data);
    pax = undefined;
    longName = undefined;
    offset = next();
  }
  if (!files.size) throw new Error("The GitHub archive contains no files.");
  const commit = root?.match(/-([0-9a-f]{7,40})$/i)?.[1];
  return { files, ...(root ? { root } : {}), ...(commit ? { commit } : {}) };
}

const branchCache = new Map<string, Promise<{ branch: string }>>();

export function resetGithubArchiveCache(): void {
  branchCache.clear();
}

/** Resolves a source to `{ref, commit}`. Only repository-root URLs need the
 * GitHub API; tree/blob/raw URLs already carry their ref. */
async function resolveRef(
  source: GithubSource,
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
  apiBase: string
): Promise<{ ref: string; commit?: string }> {
  if (source.ref) {
    return { ref: source.ref, ...(/^[0-9a-f]{7,40}$/i.test(source.ref) ? { commit: source.ref } : {}) };
  }
  const key = `${source.owner}/${source.repo}`.toLowerCase();
  let cached = branchCache.get(key);
  if (!cached) {
    cached = (async () => {
      const response = await fetcher(`${apiBase}/repos/${source.owner}/${source.repo}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Dext" },
        signal
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${key}. Paste a tree URL that includes a branch.`);
      const body = await response.json() as { default_branch?: unknown };
      if (typeof body.default_branch !== "string" || !body.default_branch) {
        throw new Error(`GitHub did not report a default branch for ${key}. Paste a tree URL that includes a branch.`);
      }
      return { branch: body.default_branch };
    })();
    branchCache.set(key, cached);
    cached.catch(() => branchCache.delete(key));
  }
  return { ref: (await cached).branch };
}

async function fetchBuffer(
  url: string,
  fetcher: typeof globalThis.fetch,
  signal: AbortSignal,
  limits: ArchiveLimits
): Promise<Uint8Array> {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(current, {
      headers: { "User-Agent": "Dext", Accept: "application/octet-stream" },
      redirect: "manual",
      signal
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("GitHub redirected the archive without a location.");
      const next = new URL(location, current).toString();
      if (!allowedRedirect(next)) throw new Error("GitHub redirected the archive to an unsupported host.");
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`GitHub returned ${response.status} while downloading the archive.`);
    const length = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > limits.maxCompressedBytes) {
      throw new Error(`The GitHub archive is larger than ${limits.maxCompressedBytes} bytes.`);
    }
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > limits.maxCompressedBytes) throw new Error(`The GitHub archive is larger than ${limits.maxCompressedBytes} bytes.`);
    return body;
  }
  throw new Error("GitHub redirected the archive too many times.");
}

/** Downloads and extracts one public repository snapshot in memory. */
export async function fetchGithubArchive(source: GithubSource, options: FetchArchiveOptions = {}): Promise<FetchedArchive> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const codeloadBase = (options.codeloadBase ?? "https://codeload.github.com").replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), limits.timeoutMs);
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const resolved = await resolveRef(source, fetcher, controller.signal, apiBase);
    const archive = await fetchBuffer(
      `${codeloadBase}/${source.owner}/${source.repo}/tar.gz/${encodeURIComponent(resolved.ref)}`,
      fetcher,
      controller.signal,
      limits
    );
    const extracted = extractTarGz(archive, limits);
    return {
      ...extracted,
      source,
      ref: resolved.ref,
      ...((resolved.commit ?? extracted.commit) ? { commit: resolved.commit ?? extracted.commit! } : {})
    };
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error(`GitHub did not respond within ${limits.timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
