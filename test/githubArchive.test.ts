import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ARCHIVE_LIMITS, extractTarGz, fetchGithubArchive, resetGithubArchiveCache } from "../src/features/resources/host/githubArchive.js";
import type { GithubSource } from "../src/features/resources/domain/skillSource.js";

function write(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  target.set(bytes.subarray(0, length), offset);
}

function header(name: string, size: number, type: string, prefix = ""): Uint8Array {
  const block = new Uint8Array(512);
  write(block, 0, 100, name);
  write(block, 100, 8, "0000644\0");
  write(block, 108, 8, "0000000\0");
  write(block, 116, 8, "0000000\0");
  write(block, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  write(block, 136, 12, "00000000000\0");
  write(block, 148, 8, "        ");
  write(block, 156, 1, type);
  write(block, 257, 6, "ustar\0");
  write(block, 263, 2, "00");
  write(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  write(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function pad(size: number): number {
  return (512 - (size % 512)) % 512;
}

interface TarEntry { path: string; content?: string; type?: string; prefix?: string; paxPath?: string; gnuName?: string; }

function paxBody(value: string): Uint8Array {
  const base = `path=${value}\n`;
  let length = base.length + 2;
  for (;;) {
    const record = `${length} ${base}`;
    if (record.length === length) return new TextEncoder().encode(record);
    length = record.length;
  }
}

function tar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.paxPath) {
      const body = paxBody(entry.paxPath);
      chunks.push(header("PaxHeader", body.length, "x"), body, new Uint8Array(pad(body.length)));
    }
    if (entry.gnuName) {
      const body = new TextEncoder().encode(`${entry.gnuName}\0`);
      chunks.push(header("LongLink", body.length, "L"), body, new Uint8Array(pad(body.length)));
    }
    const content = new TextEncoder().encode(entry.content ?? "");
    chunks.push(header(entry.path, content.length, entry.type ?? "0", entry.prefix), content, new Uint8Array(pad(content.length)));
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function archive(entries: TarEntry[]): Uint8Array {
  return new Uint8Array(gzipSync(tar(entries)));
}

function fixture(paths: string[]): Uint8Array {
  return archive(paths.map((path) => ({ path: `repo-abc1234/${path}`, content: `content of ${path}` })));
}

function githubRepo(): GithubSource {
  return {
    kind: "repo", owner: "acme", repo: "skills", path: "",
    repositoryUrl: "https://github.com/acme/skills"
  };
}

function response(body: Uint8Array | string | null, init: { status?: number; headers?: Record<string, string> } = {}) {
  const headers = init.headers ?? {};
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(typeof body === "string" ? body : "null") as unknown,
    arrayBuffer: async () => body instanceof Uint8Array ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new TextEncoder().encode(String(body ?? "")).buffer
  } as unknown as Response;
}

describe("GitHub archive extraction", () => {
  it("keeps the documented download and expansion caps", () => {
    expect(DEFAULT_ARCHIVE_LIMITS.maxCompressedBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_ARCHIVE_LIMITS.maxExpandedBytes).toBe(25 * 1024 * 1024);
    expect(DEFAULT_ARCHIVE_LIMITS.timeoutMs).toBe(20_000);
  });

  it("strips the repository root and records the commit", () => {
    const extracted = extractTarGz(fixture(["SKILL.md", "commands/review.md"]));
    expect([...extracted.files.keys()]).toEqual(["SKILL.md", "commands/review.md"]);
    expect(extracted.commit).toBe("abc1234");
    expect(new TextDecoder().decode(extracted.files.get("SKILL.md"))).toBe("content of SKILL.md");
    // GitHub archives include directory entries, often with a trailing slash.
    const nested = extractTarGz(archive([
      { path: "repo-abc1234/", type: "5" },
      { path: "repo-abc1234/skills/", type: "5" },
      { path: "repo-abc1234/skills/SKILL.md", content: "x" }
    ]));
    expect([...nested.files.keys()]).toEqual(["skills/SKILL.md"]);
  });

  it("rejects traversal, absolute paths, backslashes and duplicate entries", () => {
    expect(() => extractTarGz(fixture(["../escape.md"]))).toThrow("Unsafe tar entry path");
    expect(() => extractTarGz(fixture(["/absolute.md"]))).toThrow("Unsafe tar entry path");
    expect(() => extractTarGz(fixture(["dir\\file.md"]))).toThrow("Invalid tar entry path");
    expect(() => extractTarGz(archive([
      { path: "repo-abc1234/SKILL.md", content: "a" },
      { path: "repo-abc1234/SKILL.md", content: "b" }
    ]))).toThrow("Duplicate tar entry");
    expect(() => extractTarGz(archive([
      { path: "repo-abc1234/SKILL.md", content: "a" },
      { path: "repo-abc1234/skill.md", content: "b" }
    ]))).toThrow("Duplicate tar entry");
  });

  it("rejects links, devices and bad checksums", () => {
    expect(() => extractTarGz(archive([{ path: "repo-abc1234/link", type: "2" }]))).toThrow("link");
    expect(() => extractTarGz(archive([{ path: "repo-abc1234/hard", type: "1" }]))).toThrow("link");
    expect(() => extractTarGz(archive([{ path: "repo-abc1234/fifo", type: "6" }]))).toThrow("device or FIFO");
    const broken = tar([{ path: "repo-abc1234/SKILL.md", content: "x" }]);
    broken[0] = 0x31;
    expect(() => extractTarGz(new Uint8Array(gzipSync(broken)))).toThrow("checksum");
  });

  it("honours PAX and GNU long names and the expanded size cap", () => {
    const pax = extractTarGz(archive([{ path: "placeholder", content: "x", paxPath: "repo-abc1234/deep/nested/SKILL.md" }]));
    expect([...pax.files.keys()]).toEqual(["deep/nested/SKILL.md"]);
    const long = "repo-abc1234/" + "a".repeat(120) + "/SKILL.md";
    const gnu = extractTarGz(archive([{ path: "short", content: "x", gnuName: long }]));
    expect([...gnu.files.keys()]).toEqual([`${"a".repeat(120)}/SKILL.md`]);
    expect(() => extractTarGz(fixture(["SKILL.md"]), { maxExpandedBytes: 100 })).toThrow("expands beyond");
  });

  it("rejects an archive with no files", () => {
    expect(() => extractTarGz(new Uint8Array(gzipSync(new Uint8Array(1024))))).toThrow("no files");
  });
});

describe("fetchGithubArchive", () => {
  it("caches the default branch and downloads one snapshot", async () => {
    resetGithubArchiveCache();
    const api = vi.fn(async () => response(JSON.stringify({ default_branch: "main" })));
    const codeload = vi.fn(async () => response(fixture(["SKILL.md"])));
    const fetch = vi.fn(async (input: string) => String(input).startsWith("https://api.github.com") ? api() : codeload());
    const first = await fetchGithubArchive(githubRepo(), { fetch: fetch as never });
    expect(first.ref).toBe("main");
    expect(first.commit).toBe("abc1234");
    expect(first.files.has("SKILL.md")).toBe(true);
    await fetchGithubArchive(githubRepo(), { fetch: fetch as never });
    expect(api).toHaveBeenCalledOnce();
    expect(codeload).toHaveBeenCalledTimes(2);
  });

  it("rejects an unallowlisted redirect", async () => {
    resetGithubArchiveCache();
    const fetch = vi.fn(async (input: string) => String(input).startsWith("https://api.github.com")
      ? response(JSON.stringify({ default_branch: "main" }))
      : response(null, { status: 302, headers: { location: "https://evil.example/archive" } }));
    await expect(fetchGithubArchive(githubRepo(), { fetch: fetch as never })).rejects.toThrow("unsupported host");
  });

  it("follows allowed redirects", async () => {
    resetGithubArchiveCache();
    const fetch = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith("https://api.github.com")) return response(JSON.stringify({ default_branch: "main" }));
      if (url.includes("codeload.github.com")) return response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/archive.tar.gz" } });
      return response(fixture(["SKILL.md"]));
    });
    const result = await fetchGithubArchive(githubRepo(), { fetch: fetch as never });
    expect(result.files.has("SKILL.md")).toBe(true);
  });

  it("reports a download timeout and a failed branch lookup", async () => {
    resetGithubArchiveCache();
    const hanging = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    await expect(fetchGithubArchive(githubRepo(), { fetch: hanging as never, limits: { timeoutMs: 5 } }))
      .rejects.toThrow("did not respond within 5 ms");

    resetGithubArchiveCache();
    const denied = vi.fn(async () => response(JSON.stringify({}), { status: 403 }));
    await expect(fetchGithubArchive(githubRepo(), { fetch: denied as never }))
      .rejects.toThrow("GitHub returned 403");
  });

  it("uses a ref from the URL without calling the API", async () => {
    resetGithubArchiveCache();
    const fetch = vi.fn(async () => response(fixture(["SKILL.md"])));
    const source: GithubSource = { ...githubRepo(), kind: "tree", ref: "release/1", path: "skills/review" };
    const result = await fetchGithubArchive(source, { fetch: fetch as never });
    expect(result.ref).toBe("release/1");
    expect(fetch).toHaveBeenCalledOnce();
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain("tar.gz/release%2F1");
  });
});
