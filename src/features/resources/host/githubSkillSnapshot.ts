import type { GithubSource } from "../domain/skillSource.js";
import {
  DEFAULT_ARCHIVE_LIMITS,
  GithubHttpError,
  fetchGithubArchive,
  fetchGithubBytes,
  type FetchArchiveOptions,
  type FetchedArchive
} from "./githubArchive.js";

/** The index contains names only. `files` contains bytes only after loadFiles,
 * allowing discovery and selection before supporting files are downloaded. */
export interface GithubSkillSnapshot extends FetchedArchive {
  paths: string[];
  /** Git blob hashes let import compare supporting files without downloading them. */
  fileHashes?: ReadonlyMap<string, string>;
  loadFiles(paths: readonly string[]): Promise<void>;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  size?: number;
  sha?: string;
}

const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 100_000;

async function withTimeout<T>(options: FetchArchiveOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options.limits?.timeoutMs ?? DEFAULT_ARCHIVE_LIMITS.timeoutMs;
  const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  try {
    controller.signal.throwIfAborted();
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) throw new Error(`GitHub did not respond within ${timeoutMs} ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function safePath(path: string): boolean {
  return Boolean(path) && !path.includes("\\") && !Array.from(path).some((character) => character.charCodeAt(0) < 32)
    && path.split("/").every((part) => Boolean(part) && part !== "." && part !== ".." && !part.includes(":"));
}

/** Uses a pinned Git tree and raw files, so unrelated assets never consume the
 * import's byte budget. Rate-limited or truncated indexes use the bounded tar
 * downloader for compatibility with public repositories. */
export async function fetchGithubSkillSnapshot(source: GithubSource, options: FetchArchiveOptions = {}): Promise<GithubSkillSnapshot> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...options.limits };
  const fetcher = options.fetch ?? globalThis.fetch;
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const repoApi = `${apiBase}/repos/${source.owner}/${source.repo}`;
  const ref = source.ref ?? "HEAD";
  let commit: string | undefined;
  const fallback = async (): Promise<GithubSkillSnapshot> => {
    // HEAD works without a default-branch API lookup when the API is limited.
    const archive = await fetchGithubArchive({ ...source, ref: commit ?? ref }, options);
    return { ...archive, source, ref, paths: [...archive.files.keys()], loadFiles: async () => {} };
  };
  let entries: TreeEntry[];
  let truncated = false;
  try {
    const index = await withTimeout(options, async (signal) => {
      const json = async (url: string): Promise<unknown> => JSON.parse(new TextDecoder().decode(await fetchGithubBytes(
        url, fetcher, signal, { ...limits, maxCompressedBytes: MAX_INDEX_BYTES }, "The GitHub file index", "application/vnd.github+json"
      ))) as unknown;
      const resolved = await json(`${repoApi}/commits/${encodeURIComponent(ref)}`) as { sha?: string; commit?: { tree?: { sha?: string } } };
      if (!/^[0-9a-f]{40}$/i.test(resolved.sha ?? "") || !/^[0-9a-f]{40}$/i.test(resolved.commit?.tree?.sha ?? "")) {
        throw new Error("GitHub did not return a valid repository snapshot.");
      }
      commit = resolved.sha!;
      return await json(`${repoApi}/git/trees/${resolved.commit!.tree!.sha}?recursive=1`) as { tree?: TreeEntry[]; truncated?: boolean };
    });
    truncated = index.truncated === true;
    if (!Array.isArray(index.tree) || index.tree.length > MAX_INDEX_ENTRIES) throw new Error("The GitHub file index is invalid or too large.");
    entries = index.tree;
  } catch (error) {
    if (error instanceof GithubHttpError && (error.status === 403 || error.status === 429)) return await fallback();
    throw error;
  }
  if (truncated) return await fallback();

  const indexed = new Map<string, TreeEntry>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.path !== "string" || !safePath(entry.path)) throw new Error("The GitHub file index contains an unsafe path.");
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate GitHub entry: ${entry.path}`);
    seen.add(key);
    if (entry.type !== "tree") indexed.set(entry.path, entry);
  }
  const files = new Map<string, Uint8Array>();
  let downloadedBytes = 0;
  const maxBytes = Math.min(limits.maxCompressedBytes, limits.maxExpandedBytes);
  return {
    source, ref, commit: commit!, files, paths: [...indexed.keys()],
    fileHashes: new Map([...indexed].flatMap(([path, entry]) => /^[0-9a-f]{40}$/i.test(entry.sha ?? "")
      ? [[path, `${entry.mode}:${entry.sha!}`] as const] : [])),
    async loadFiles(paths) {
      const pending = [...new Set(paths)].filter((path) => !files.has(path));
      if (files.size + pending.length > limits.maxFiles) throw new Error(`The selected GitHub files exceed the ${limits.maxFiles} file limit.`);
      let plannedBytes = downloadedBytes;
      // Preflight the complete selection before starting any supporting download.
      for (const path of pending) {
        const entry = indexed.get(path);
        if (!entry) throw new Error(`The GitHub snapshot has no file '${path}'.`);
        if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
          throw new Error(`The selected GitHub file '${path}' is a link or submodule, which cannot be imported safely.`);
        }
        if (!Number.isSafeInteger(entry.size) || entry.size! < 0) throw new Error(`GitHub did not report a valid size for '${path}'.`);
        plannedBytes += entry.size!;
      }
      if (plannedBytes > maxBytes) throw new Error(`The selected GitHub files exceed the ${(maxBytes / 1024 / 1024).toFixed(1)} MiB download limit.`);
      await withTimeout(options, async (signal) => {
        // Four workers keep raw-file requests bounded without serial round trips.
        let next = 0;
        const download = async (): Promise<void> => {
          while (next < pending.length) {
            signal.throwIfAborted();
            const path = pending[next++]!;
            const entry = indexed.get(path)!;
            const url = `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;
            const bytes = await fetchGithubBytes(url, fetcher, signal,
              { ...limits, maxCompressedBytes: entry.size! }, `GitHub file '${path}'`);
            if (bytes.byteLength !== entry.size) throw new Error(`GitHub returned an unexpected size for '${path}'.`);
            files.set(path, bytes);
            downloadedBytes += bytes.byteLength;
          }
        };
        // Observe all workers even when one fails; no downloads outlive a load.
        const results = await Promise.allSettled(Array.from({ length: Math.min(4, pending.length) }, download));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
    }
  };
}
