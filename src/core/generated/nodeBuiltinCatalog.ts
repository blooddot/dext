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
}

const node = (id: string, title: string, module: string, exportName: string, input: CallableDefinition["input"], output: CallableDefinition["output"], capability: NodeBuiltinEntry["capability"] = "pure"): NodeBuiltinEntry => ({
  method: { id, title, description: `Controlled bridge to ${module}.${exportName}.`, kind: "command", version: "1.0.0", input, output, executor: { kind: "deterministic", handler: "nodeBuiltin" } },
  module, exportName, argumentOrder: input.map((field) => field.name), capability
});

const scalar = (id: string, title: string, module: string, exportName: string, input: CallableDefinition["input"], capability: NodeBuiltinEntry["capability"] = "pure") => node(id, title, module, exportName, input, { kind: "node", fields: [{ name: "value", type: "string", required: true }] }, capability);

export const NODE_BUILTIN_CATALOG: readonly NodeBuiltinEntry[] = [
  node("node.url.parse", "URL parse", "node:url", "parse", [{ name: "url", type: "string", required: true }], { kind: "node", fields: [{ name: "protocol", type: "string", nullable: true }, { name: "host", type: "string", nullable: true }, { name: "pathname", type: "string", required: true }, { name: "query", type: "object", accepts: ["string"], nullable: true }] }),
  scalar("node.url.format", "URL format", "node:url", "format", [{ name: "urlObject", type: "object", required: true }]),
  scalar("node.url.fileURLToPath", "File URL to path", "node:url", "fileURLToPath", [{ name: "url", type: "string", required: true }]),
  scalar("node.url.pathToFileURL", "Path to file URL", "node:url", "pathToFileURL", [{ name: "path", type: "string", required: true }]),
  ...["basename", "dirname", "extname", "normalize", "isAbsolute", "parse", "relative", "resolve"].map((exportName) => node(`node.path.${exportName}`, `path.${exportName}`, "node:path", exportName, exportName === "parse" ? [{ name: "path", type: "string", required: true }] : [{ name: "path", type: "string", required: true }], exportName === "isAbsolute" ? { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] } : exportName === "parse" ? { kind: "node", fields: [{ name: "root", type: "string" }, { name: "dir", type: "string" }, { name: "base", type: "string" }, { name: "ext", type: "string" }, { name: "name", type: "string" }] } : { kind: "node", fields: [{ name: "value", type: "string", required: true }] })),
  node("node.path.join", "path.join", "node:path", "join", [{ name: "paths", type: "list", items: { name: "path", type: "string" }, required: true }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }),
  node("node.querystring.parse", "querystring.parse", "node:querystring", "parse", [{ name: "query", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "object", required: true }] }),
  node("node.querystring.stringify", "querystring.stringify", "node:querystring", "stringify", [{ name: "object", type: "object", required: true }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }),
  node("node.util.stripVTControlCharacters", "util.stripVTControlCharacters", "node:util", "stripVTControlCharacters", [{ name: "str", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }),
  node("node.util.isDeepStrictEqual", "util.isDeepStrictEqual", "node:util", "isDeepStrictEqual", [{ name: "val1", type: "object", required: true }, { name: "val2", type: "object", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }),
  node("node.util.parseArgs", "util.parseArgs", "node:util", "parseArgs", [{ name: "args", type: "list", items: { name: "arg", type: "string" }, required: true }], { kind: "node", fields: [{ name: "values", type: "object", required: true }, { name: "positionals", type: "list", items: { name: "arg", type: "string" }, required: true }] }),
  node("node.fs.readFile", "fs.readFile", "node:fs/promises", "readFile", [{ name: "path", type: "string", required: true }, { name: "encoding", type: "string", default: "utf8" }], { kind: "node", fields: [{ name: "value", type: "string", required: true }] }, "fs"),
  node("node.fs.writeFile", "fs.writeFile", "node:fs/promises", "writeFile", [{ name: "path", type: "string", required: true }, { name: "content", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }, "fs"),
  node("node.fs.appendFile", "fs.appendFile", "node:fs/promises", "appendFile", [{ name: "path", type: "string", required: true }, { name: "content", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }, "fs"),
  node("node.fs.mkdir", "fs.mkdir", "node:fs/promises", "mkdir", [{ name: "path", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "string", nullable: true }] }, "fs"),
  node("node.fs.rename", "fs.rename", "node:fs/promises", "rename", [{ name: "oldPath", type: "string", required: true }, { name: "newPath", type: "string", required: true }], { kind: "node", fields: [{ name: "value", type: "boolean", required: true }] }, "fs"),
  node("node.http.request", "HTTP request", "node:http", "request", [{ name: "url", type: "string", required: true }, { name: "method", type: "string", default: "GET" }, { name: "headers", type: "object", default: {} }, { name: "body", type: "string", default: "" }, { name: "timeout_ms", type: "number", default: 30000 }], { kind: "node", fields: [{ name: "status", type: "number", required: true }, { name: "headers", type: "object", required: true }, { name: "body", type: "string", required: true }, { name: "url", type: "string", required: true }] }, "http")
];

export const NODE_BUILTIN_METHODS = NODE_BUILTIN_CATALOG.map((entry) => entry.method);
