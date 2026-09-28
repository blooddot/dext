// Generated catalog source. `npm run generate:node-builtins` validates the
// declaration-driven surface; this checked-in file keeps runtime independent
// from @types/node.
import type { CallableDefinition } from "../types.js";

export interface NodeBuiltinEntry {
  method: CallableDefinition;
  module: string;
  exportName: string;
  argumentOrder: readonly string[];
  capability: "pure" | "fs" | "http";
  /** Narrows a Node return value the `node` result shape cannot carry as-is,
   * because Node hands back a class instance rather than a plain object. The
   * projection must return plain JSON values. */
  project?: (value: unknown) => unknown;
}

/** `node.fs.stat` reports the few facts a workflow can act on. A `Stats`
 * instance carries methods and fails the plain-object result check. */
function projectStat(value: unknown): Record<string, unknown> {
  const stats = value as { size: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean };
  return { size: stats.size, mtime_ms: stats.mtimeMs, is_file: stats.isFile(), is_directory: stats.isDirectory() };
}

const node = (id: string, title: string, module: string, exportName: string, input: CallableDefinition["input"], output: CallableDefinition["output"], capability: NodeBuiltinEntry["capability"] = "pure", project?: NodeBuiltinEntry["project"]): NodeBuiltinEntry => ({
  method: { id, title, description: `Controlled bridge to ${module}.${exportName}.`, kind: "command", version: "1.0.0", input, output, executor: { kind: "deterministic", handler: "nodeBuiltin" } },
  module, exportName, argumentOrder: input.map((field) => field.name), capability, ...(project ? { project } : {})
});

const scalar = (id: string, title: string, module: string, exportName: string, input: CallableDefinition["input"], capability: NodeBuiltinEntry["capability"] = "pure") => node(id, title, module, exportName, input, { kind: "node", fields: [{ name: "value", type: "string", required: true }] }, capability);

export const NODE_BUILTIN_CATALOG: readonly NodeBuiltinEntry[] = [
  node("node.url.parse", "URL parse", "node:url", "parse", [{ name: "url", type: "string", required: true }], { kind: "node", fields: [{ name: "protocol", type: "string", nullable: true }, { name: "host", type: "string", nullable: true }, { name: "pathname", type: "string", required: true }, { name: "query", type: "object", accepts: ["string"], nullable: true }] }),
  scalar("node.url.format", "URL format", "node:url", "format", [{ name: "urlObject", type: "object", required: true }]),
  scalar("node.url.fileURLToPath", "File URL to path", "node:url", "fileURLToPath", [{ name: "url", type: "string", required: true }]),
  scalar("node.url.pathToFileURL", "Path to file URL", "node:url", "pathToFileURL", [{ name: "path", type: "string", required: true }]),
  node("node.path.relative", "path.relative", "node:path", "relative", [{ name: "from", type: "string", required: true }, { name: "to", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }),
  node("node.path.format", "path.format", "node:path", "format", [{ name: "pathObject", type: "object", required: true, description: "A parsed path object, usually the result of node.path.parse." }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }),
  ...["basename", "dirname", "extname", "normalize", "isAbsolute", "parse", "resolve"].map((exportName) => node(`node.path.${exportName}`, `path.${exportName}`, "node:path", exportName, exportName === "parse" ? [{ name: "path", type: "string", required: true }] : [{ name: "path", type: "string", required: true }], exportName === "isAbsolute" ? { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] } : exportName === "parse" ? { kind: "node", fields: [{ name: "root", type: "string" }, { name: "dir", type: "string" }, { name: "base", type: "string" }, { name: "ext", type: "string" }, { name: "name", type: "string" }] } : { kind: "node", fields: [{ name: "value", type: "string", required: true }] })),
  node("node.path.join", "path.join", "node:path", "join", [{ name: "paths", type: "list", items: { name: "path", type: "string" }, required: true }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }),
  node("node.querystring.parse", "querystring.parse", "node:querystring", "parse", [{ name: "query", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "object", required: true }] }),
  node("node.querystring.stringify", "querystring.stringify", "node:querystring", "stringify", [{ name: "object", type: "object", required: true }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }),
  node("node.util.stripVTControlCharacters", "util.stripVTControlCharacters", "node:util", "stripVTControlCharacters", [{ name: "str", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }),
  node("node.util.isDeepStrictEqual", "util.isDeepStrictEqual", "node:util", "isDeepStrictEqual", [{ name: "val1", type: "object", required: true }, { name: "val2", type: "object", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }),
  node("node.util.parseArgs", "util.parseArgs", "node:util", "parseArgs", [{ name: "args", type: "list", items: { name: "arg", type: "string" }, required: true }], { kind: "node", fields: [{ name: "values", type: "object", required: true }, { name: "positionals", type: "list", items: { name: "arg", type: "string" }, required: true }] }),
  node("node.fs.readFile", "fs.readFile", "node:fs/promises", "readFile", [{ name: "path", type: "string", required: true }, { name: "encoding", type: "string", default: "utf8" }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }, "fs"),
  node("node.fs.readdir", "fs.readdir", "node:fs/promises", "readdir", [{ name: "path", type: "string", required: true }, { name: "encoding", type: "string", default: "utf8" }], { kind: "node", fields: [{ name: "value", type: "list", items: { name: "entry", type: "string" }, required: true, description: "Entry names in the platform's directory order; sort them when the order matters." }] }, "fs"),
  node("node.fs.stat", "fs.stat", "node:fs/promises", "stat", [{ name: "path", type: "string", required: true }], { kind: "node", fields: [{ name: "size", type: "number", required: true }, { name: "mtime_ms", type: "number", required: true }, { name: "is_file", type: "boolean", required: true }, { name: "is_directory", type: "boolean", required: true }] }, "fs", projectStat),
  node("node.fs.access", "fs.access", "node:fs/promises", "access", [{ name: "path", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true, description: "True when the path is reachable; an unreachable path raises the Node error instead." }] }, "fs"),
  node("node.fs.realpath", "fs.realpath", "node:fs/promises", "realpath", [{ name: "path", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }, "fs"),
  node("node.fs.writeFile", "fs.writeFile", "node:fs/promises", "writeFile", [{ name: "path", type: "string", required: true }, { name: "content", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }, "fs"),
  node("node.fs.appendFile", "fs.appendFile", "node:fs/promises", "appendFile", [{ name: "path", type: "string", required: true }, { name: "content", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }, "fs"),
  node("node.fs.copyFile", "fs.copyFile", "node:fs/promises", "copyFile", [{ name: "sourcePath", type: "string", required: true }, { name: "destinationPath", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }, "fs"),
  node("node.fs.mkdir", "fs.mkdir", "node:fs/promises", "mkdir", [{ name: "path", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "string", nullable: true }] }, "fs"),
  node("node.fs.rename", "fs.rename", "node:fs/promises", "rename", [{ name: "oldPath", type: "string", required: true }, { name: "newPath", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }, "fs"),
  node("node.fs.rm", "fs.rm", "node:fs/promises", "rm", [{ name: "path", type: "string", required: true }, { name: "recursive", type: "boolean", default: false, description: "Remove a directory and its contents; a directory is refused without it." }, { name: "force", type: "boolean", default: false, description: "Ignore a missing path instead of raising the Node error." }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }, "fs"),
  node("node.http.request", "HTTP request", "node:http", "request", [{ name: "url", type: "string", required: true }, { name: "method", type: "string", default: "GET" }, { name: "headers", type: "object", default: {} }, { name: "body", type: "string", default: "" }, { name: "timeout_ms", type: "number", default: 30000 }], { kind: "node", fields: [{ name: "status", type: "number", required: true }, { name: "headers", type: "object", required: true }, { name: "body", type: "string", required: true }, { name: "url", type: "string", required: true }] }, "http")
];

export const NODE_BUILTIN_METHODS = NODE_BUILTIN_CATALOG.map((entry) => entry.method);
