/** Pure URL/config validation shared by the MCP manifest reader and the runtime
 * registry, so neither has to import the other. */
function isLoopbackHost(host: string): boolean {
  return host === "localhost"
    || host === "::1"
    || host === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function httpUrlDiagnostic(rawUrl: unknown): string | undefined {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "requires an HTTP url.";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "has an invalid HTTP url.";
  }
  if (url.username || url.password) return "url must not contain userinfo.";
  if (url.search) return "url must not contain a query string.";
  if (url.hash) return "url must not contain a fragment.";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return undefined;
  return "url must use HTTPS or loopback HTTP.";
}
