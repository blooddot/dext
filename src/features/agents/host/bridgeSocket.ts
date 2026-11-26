import { tmpdir } from "node:os";
import { join } from "node:path";

/** macOS caps a unix socket path at 104 bytes and Linux at 108, while a
 * GUI-launched editor's TMPDIR already spends about 50 on its own. The
 * endpoint only needs to be unique, not guessable, so a short token prefix
 * stays far inside the limit; /tmp is the fallback when TMPDIR is still too
 * long for the preferred name. */
export function bridgeSocketPath(prefix: string, token: string): string {
  const name = `${prefix}${token.slice(0, 24)}.sock`;
  const preferred = join(tmpdir(), name);
  return Buffer.byteLength(preferred) <= 100 ? preferred : join("/tmp", name);
}
