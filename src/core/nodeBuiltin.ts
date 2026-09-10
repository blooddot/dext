import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { NODE_BUILTIN_CATALOG, type NodeBuiltinEntry } from "./generated/nodeBuiltinCatalog.js";
import { NODE_HTTP_DEFAULT_TIMEOUT_MS, NODE_HTTP_MAX_BYTES, NODE_HTTP_MAX_REDIRECTS } from "./nodeBuiltinPolicy.js";
import type { DextResult, ResolvedInvocation } from "./types.js";

const entries = new Map(NODE_BUILTIN_CATALOG.map((entry) => [entry.method.id, entry]));
const SENSITIVE_HEADER = /^(authorization|cookie|proxy-authorization|x-.*token.*)$/i;

function contained(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function workspacePath(root: string, value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value)) throw new Error("node.fs paths must be non-empty workspace-relative paths.");
  const candidate = resolve(root, value);
  if (!contained(root, candidate)) throw new Error("node.fs path must stay inside the workspace.");
  // Existing files are resolved to their physical target, preventing symlink
  // escapes. For new files validate the nearest existing parent instead.
  let probe = candidate;
  while (true) {
    try {
      const physical = await realpath(probe);
      if (!contained(root, physical)) throw new Error("node.fs path escapes the workspace through a symbolic link.");
      break;
    } catch (error) {
      if (error instanceof Error && error.message.includes("symbolic link")) throw error;
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      probe = parent;
    }
  }
  return candidate;
}

function serializable(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "undefined") return null;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") throw new Error("Node result is not JSON serializable.");
  if (value instanceof URL) return value.href;
  if (Buffer.isBuffer(value)) throw new Error("Binary Node results are not supported; request a text encoding.");
  if (Array.isArray(value)) return value.map((item) => serializable(item, seen));
  if (typeof value !== "object") throw new Error("Unsupported Node result.");
  if (seen.has(value)) throw new Error("Node result contains a cycle.");
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Node result must be a plain object.");
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) output[key] = serializable(item, seen);
  seen.delete(value);
  return output;
}

function output(entry: NodeBuiltinEntry, value: unknown): DextResult {
  const fields = entry.method.output.fields ?? [];
  if (fields.some((field) => field.name === "value")) return { kind: "node", value: serializable(value === undefined ? true : value) } as DextResult;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${entry.method.id} must return an object.`);
  const record: Record<string, unknown> = { kind: "node" };
  for (const field of fields) {
    const item = (value as Record<string, unknown>)[field.name];
    if (item !== undefined) record[field.name] = serializable(item);
    else if (field.required) throw new Error(`${entry.method.id} did not return '${field.name}'.`);
  }
  return record as DextResult;
}

async function httpRequest(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = typeof args.url === "string" ? args.url : "";
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("node.http.request only supports http and https URLs.");
  const timeout = typeof args.timeout_ms === "number" ? Math.min(Math.max(args.timeout_ms, 1), NODE_HTTP_DEFAULT_TIMEOUT_MS) : NODE_HTTP_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = typeof args.headers === "object" && args.headers !== null && !Array.isArray(args.headers) ? args.headers as Record<string, string> : {};
    let current = url;
    for (let redirect = 0; redirect <= NODE_HTTP_MAX_REDIRECTS; redirect += 1) {
      const requestBody = typeof args.body === "string" && args.body ? args.body : undefined;
      const response = await fetch(current, { method: typeof args.method === "string" ? args.method : "GET", headers, ...(requestBody === undefined ? {} : { body: requestBody }), redirect: "manual", signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) break;
        current = new URL(location, current).href;
        continue;
      }
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > NODE_HTTP_MAX_BYTES) throw new Error("HTTP response exceeds the 1 MB limit.");
      const responseBody = await response.text();
      if (Buffer.byteLength(responseBody) > NODE_HTTP_MAX_BYTES) throw new Error("HTTP response exceeds the 1 MB limit.");
      return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: responseBody, url: response.url };
    }
    throw new Error("HTTP request exceeded the redirect limit.");
  } finally { clearTimeout(timer); }
}

export function redactNodeArguments(arguments_: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...arguments_ };
  if (typeof copy.headers === "object" && copy.headers !== null && !Array.isArray(copy.headers)) {
    copy.headers = Object.fromEntries(Object.entries(copy.headers as Record<string, unknown>).map(([name, value]) => [name, SENSITIVE_HEADER.test(name) ? "[REDACTED]" : value]));
  }
  return copy;
}

export async function executeNodeBuiltin(invocation: ResolvedInvocation, workspaceRoot: string, trusted: boolean): Promise<DextResult> {
  const entry = entries.get(invocation.method.id);
  if (!entry) throw new Error(`Unknown Node builtin '${invocation.method.id}'.`);
  if ((entry.capability === "fs" || entry.capability === "http") && !trusted) throw new Error(`${entry.method.id} requires a trusted workspace.`);
  if (entry.capability === "http") return output(entry, await httpRequest(invocation.arguments));
  const imported = await import(entry.module) as unknown as Record<string, unknown>;
  const fn = imported[entry.exportName];
  if (typeof fn !== "function") throw new Error(`${entry.module}.${entry.exportName} is unavailable in this Node runtime.`);
  const args = await Promise.all(entry.argumentOrder.map(async (name) => {
    const value = invocation.arguments[name];
    if (entry.capability === "fs" && /(^path$|Path$)/.test(name)) return workspacePath(workspaceRoot, value);
    return value;
  }));
  let value: unknown;
  if (entry.method.id === "node.path.join") value = Reflect.apply(fn, imported, Array.isArray(invocation.arguments.paths) ? invocation.arguments.paths : []);
  else if (entry.method.id === "node.util.parseArgs") value = Reflect.apply(fn, imported, [{ args: invocation.arguments.args }]);
  else value = await Reflect.apply(fn, imported, args);
  return output(entry, value);
}
