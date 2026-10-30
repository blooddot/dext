import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsDelivr, piAddressBlocked, piFetch, type PiFetchReply } from "../src/features/agents/host/piFetch.js";

let server: Server, port = 0, hits = 0;
beforeAll(async () => {
  server = createServer((request, response) => {
    hits += 1;
    const path = request.url ?? "/";
    if (path === "/ok") { response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); response.end("hello world"); }
    else if (path === "/big") { response.writeHead(200, { "content-type": "text/plain" }); response.end(Buffer.alloc(600 * 1024, 97)); }
    else if (path === "/redirect") { response.writeHead(301, { location: "/ok" }); response.end(); }
    else if (path === "/hang") return;
    else { response.writeHead(302, { location: "/loop" }); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));

/** Stands in for the real network so a public-looking hostname reaches the local server. */
async function localFetch(_input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const href = _input instanceof Request ? _input.url : _input instanceof URL ? _input.href : _input;
  const path = new URL(href).pathname;
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path, ...(init.signal ? { signal: init.signal } : {}) }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status: response.statusCode ?? 500, headers: response.headers as Record<string, string> })));
    });
    request.on("error", reject);
  });
}
const publicHost = async (): Promise<string[]> => ["93.184.216.34"];
const offlineFetch = (): never => { throw new Error("the network must not be used"); };
const fetchUrl = (path: string): string => `http://dext.test:${port}${path}`;
const signal = (): AbortSignal => new AbortController().signal;

describe("piFetch", () => {
  it("returns the text of a 200 response with its final URL and content type", async () => {
    await expect(piFetch(fetchUrl("/ok"), signal(), { fetch: localFetch, resolve: publicHost })).resolves
      .toEqual({ status: "ok", url: fetchUrl("/ok"), contentType: "text/plain; charset=utf-8", text: "hello world", truncated: false });
    await expect(piFetch(fetchUrl("/redirect"), signal(), { fetch: localFetch, resolve: publicHost })).resolves.toMatchObject({ status: "ok", url: fetchUrl("/ok"), text: "hello world" });
  });
  it("rejects anything that is not a credential-free http(s) URL", async () => {
    for (const url of ["file:///etc/passwd", "ftp://dext.test/ok", "dext.test/ok", "http://user:secret@dext.test/ok"]) {
      const reply = await piFetch(url, signal(), { fetch: offlineFetch, resolve: publicHost });
      expect(reply).toMatchObject({ status: "rejected" });
    }
  });
  it("rejects local and private targets before any request", async () => {
    const blocked = ["localhost", "127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254", "[::1]", "[fd00::1]", "[fe80::1]", "0.0.0.0", "dext.local"];
    for (const host of blocked) await expect(piFetch(`http://${host}/`, signal(), { fetch: offlineFetch, resolve: publicHost })).resolves.toMatchObject({ status: "rejected" });
    await expect(piFetch("http://dext.test/", signal(), { fetch: offlineFetch, resolve: async () => ["10.1.2.3"] })).resolves.toMatchObject({ status: "rejected" });
    expect(piAddressBlocked("1.1.1.1")).toBe(false);
    expect(piAddressBlocked("::ffff:127.0.0.1")).toBe(true);
  });
  it("follows redirects itself and gives up after five", async () => {
    const before = hits;
    await expect(piFetch(fetchUrl("/loop"), signal(), { fetch: localFetch, resolve: publicHost })).resolves.toMatchObject({ status: "rejected", reason: "More than 5 redirects." });
    expect(hits - before).toBe(6);
  });
  it("stops reading at 512 KiB and marks the text truncated", async () => {
    const reply = await piFetch(fetchUrl("/big"), signal(), { fetch: localFetch, resolve: publicHost }) as Extract<PiFetchReply, { status: "ok" }>;
    expect(reply).toMatchObject({ status: "ok", truncated: true });
    expect(reply.text).toHaveLength(512 * 1024);
  });
  it("rejects with the caller's cancellation", async () => {
    const controller = new AbortController();
    const pending = piFetch(fetchUrl("/hang"), controller.signal, { fetch: localFetch, resolve: publicHost });
    setTimeout(() => controller.abort(new Error("stopped by the user")), 50);
    await expect(pending).rejects.toThrow("stopped by the user");
  });
  it("reads a GitHub file through jsDelivr and falls back to the original URL", async () => {
    const seen: string[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      const href = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      seen.push(href);
      return href.startsWith("https://cdn.jsdelivr.net/")
        ? new Response(null, { status: 404 })
        : new Response("from origin", { status: 200, headers: { "content-type": "text/markdown" } });
    };
    const reply = await piFetch("https://github.com/o/r/blob/main/docs/a.md", signal(), { fetch, resolve: publicHost });
    expect(seen).toEqual(["https://cdn.jsdelivr.net/gh/o/r@main/docs/a.md", "https://github.com/o/r/blob/main/docs/a.md"]);
    expect(reply).toMatchObject({ status: "ok", text: "from origin", url: "https://github.com/o/r/blob/main/docs/a.md" });
    seen.length = 0;
    const cdnOnly = async (input: string | URL | Request): Promise<Response> => {
      seen.push(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
      return new Response("from mirror", { status: 200 });
    };
    const mirrored = await piFetch("https://raw.githubusercontent.com/o/r/v1/src/a.ts", signal(), { fetch: cdnOnly, resolve: publicHost });
    expect(seen).toEqual(["https://cdn.jsdelivr.net/gh/o/r@v1/src/a.ts"]);
    expect(mirrored).toMatchObject({ status: "ok", text: "from mirror", url: "https://cdn.jsdelivr.net/gh/o/r@v1/src/a.ts" });
    expect(jsDelivr("https://example.com/a/b.md")).toBeUndefined();
  });
});
