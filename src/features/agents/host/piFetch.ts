import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type PiFetchReply =
  | { status: "ok"; url: string; contentType: string; text: string; truncated: boolean }
  | { status: "rejected"; reason: string }
  | { status: "failed"; reason: string };

export interface PiFetchOptions {
  fetch?: typeof globalThis.fetch;
  /** Test seam only; production resolves through DNS. */
  resolve?: (hostname: string) => Promise<string[]>;
}

const MAX_REDIRECTS = 5, MAX_BYTES = 512 * 1024, TIMEOUT_MS = 20_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const HEADERS = { accept: "text/*,application/json;q=0.9,*/*;q=0.8", "user-agent": "Dext-pi-fetch" };

class Rejected extends Error {}

/** Loopback, private, link-local, multicast and unspecified addresses are never fetched. */
export function piAddressBlocked(address: string): boolean {
  const bare = address.replace(/^\[|]$/g, "").toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped?.[1]) return piAddressBlocked(mapped[1]);
  if (isIP(bare) === 6) return ["::", "::1"].includes(bare) || /^(f[cd]|fe[89ab]|ff)/.test(bare);
  const octets = bare.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return true;
  const [a, b] = octets as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function verified(href: string, resolve: NonNullable<PiFetchOptions["resolve"]>): Promise<URL> {
  let url: URL;
  try { url = new URL(href); } catch { throw new Rejected("The URL is not a valid absolute URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Rejected("Only http and https URLs can be fetched.");
  if (url.username || url.password) throw new Rejected("URLs with embedded credentials are not fetched.");
  const host = url.hostname.toLowerCase().replace(/[^a-z0-9.:-]/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".local")) throw new Rejected(`The host '${host}' is local and is not fetched.`);
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => { throw new Rejected(`The host '${host}' could not be resolved.`); });
  if (!addresses.length || addresses.some(piAddressBlocked)) throw new Rejected(`The host '${host}' resolves to a loopback, private, link-local or multicast address.`);
  // shortcut: a DNS rebinding can differ at connect time, upgrade to a pinned-address dispatcher if that threat applies.
  return url;
}

/** Read one http(s) URL as text. The only network exit of a read-only Dext turn. */
export async function piFetch(url: string, signal: AbortSignal, options: PiFetchOptions = {}): Promise<PiFetchReply> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const resolve = options.resolve ?? (async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
  const expiry = AbortSignal.timeout(TIMEOUT_MS), combined = AbortSignal.any([signal, expiry]);
  const mirror = jsDelivr(url);
  const first = await fetchOnce(mirror ?? url, signal, fetcher, resolve, expiry, combined);
  // A branch head can lag on the CDN or a large file can be missing there; the origin is the fallback.
  if (!mirror || first.status === "ok") return first;
  return fetchOnce(url, signal, fetcher, resolve, expiry, combined);
}

/** GitHub serves repository files through a CDN that stays reachable when the site does not. */
export function jsDelivr(href: string): string | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return undefined; }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [owner, repo] = parts;
  const rest = url.hostname === "raw.githubusercontent.com" ? parts.slice(2)
    : url.hostname === "github.com" && (parts[2] === "blob" || parts[2] === "raw") ? parts.slice(3) : undefined;
  const [ref, ...path] = rest ?? [];
  if (!owner || !repo || !ref || !path.length) return undefined;
  return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${path.map(encodeURIComponent).join("/")}`;
}

async function fetchOnce(url: string, signal: AbortSignal, fetcher: typeof globalThis.fetch, resolve: NonNullable<PiFetchOptions["resolve"]>, expiry: AbortSignal, combined: AbortSignal): Promise<PiFetchReply> {
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      const target = await verified(current, resolve);
      const response = await fetcher(target.href, { redirect: "manual", headers: HEADERS, signal: combined });
      const location = response.headers.get("location");
      if (REDIRECTS.has(response.status) && location) {
        await response.body?.cancel();
        if (hop === MAX_REDIRECTS) throw new Rejected(`More than ${MAX_REDIRECTS} redirects.`);
        current = new URL(location, target).href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); return { status: "failed", reason: `The server answered HTTP ${response.status}.` }; }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = [], truncated = await drain(reader, chunks);
      return { status: "ok", url: target.href, contentType: response.headers.get("content-type") ?? "", text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : error;
    if (error instanceof Rejected) return { status: "rejected", reason: error.message };
    if (expiry.aborted) return { status: "failed", reason: `The request did not finish within ${TIMEOUT_MS / 1000} seconds.` };
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array> | undefined, chunks: Uint8Array[]): Promise<boolean> {
  if (!reader) return false;
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) return false;
    const chunk = next.value;
    if (size + chunk.length > MAX_BYTES) { chunks.push(chunk.subarray(0, MAX_BYTES - size)); await reader.cancel(); return true; }
    chunks.push(chunk); size += chunk.length;
  }
}
