/** Module-level policy for the Python-shaped .dx standard library.  Function
 * signatures are generated or catalogued; this file deliberately does not
 * create a second per-function permission system. */
export const NODE_MODULE_POLICY = {
  enabled: ["node:url", "node:path", "node:querystring", "node:util", "node:fs/promises", "node:http", "node:https"],
  candidates: ["node:crypto", "node:zlib", "node:timers/promises", "node:os"],
  forbidden: ["node:child_process", "node:net", "node:tls", "node:dgram", "node:stream", "node:events", "node:worker_threads", "node:cluster", "node:vm", "node:module", "node:inspector", "node:repl"],
  namespaces: {
    "node:url": "node.url",
    "node:path": "node.path",
    "node:querystring": "node.querystring",
    "node:util": "node.util",
    "node:fs/promises": "node.fs"
  }
} as const;

export const NODE_HTTP_MAX_BYTES = 1_000_000;
export const NODE_HTTP_MAX_REDIRECTS = 5;
export const NODE_HTTP_DEFAULT_TIMEOUT_MS = 30_000;
