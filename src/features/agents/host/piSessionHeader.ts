import { open } from "node:fs/promises";

/** A session header is one short JSON line; a larger first line means this is
 * not a header we understand, and reading further would load session content. */
const MAX_HEADER_BYTES = 64 * 1024;

/** Reads the workspace recorded on the first line of a Pi session file without
 * loading the session itself, which can reach hundreds of megabytes. Anything
 * unreadable or unexpected returns `undefined` so the caller keeps Pi's own
 * behavior instead of guessing why a session cannot be resumed. */
export async function piSessionCwd(path: string): Promise<string | undefined> {
  const line = await firstLine(path);
  if (!line) return undefined;
  try {
    const header: unknown = JSON.parse(line);
    if (!header || typeof header !== "object" || Array.isArray(header)) return undefined;
    const cwd = (header as { cwd?: unknown }).cwd;
    return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
  } catch { return undefined; }
}

async function firstLine(path: string): Promise<string | undefined> {
  let handle;
  try { handle = await open(path, "r"); } catch { return undefined; }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_HEADER_BYTES) {
      const chunk = Buffer.alloc(Math.min(8192, MAX_HEADER_BYTES - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
      const newline = chunk.subarray(0, bytesRead).indexOf(10);
      if (newline !== -1) { chunks.push(chunk.subarray(0, newline)); return Buffer.concat(chunks).toString("utf8"); }
      chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead;
    }
    // No newline within the cap: this is not a header we can trust.
    return undefined;
  } catch { return undefined; }
  finally { await handle.close().catch(() => {}); }
}
