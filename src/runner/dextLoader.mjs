/**
 * The kernel's module loader.
 *
 * Registered with `module.register()` (see `docs/development.md`). It does three
 * jobs:
 *
 * 1. map the `dext` specifier to the runtime module and `dext/api/<id>` to
 *    `<workspace>/.dext/api/<id>.ts` (the same alias a `tsconfig.json` `paths`
 *    entry describes for tsserver);
 * 2. resolve extensionless relative imports inside the workspace to `.ts`;
 * 3. load `.ts` as ESM with TypeScript erased — natively through
 *    `module.stripTypeScriptTypes` when the runtime supports it, otherwise with
 *    an esbuild transform when esbuild happens to be installed.
 *
 * The kernel re-registers this loader with a fresh `data.generation` before every
 * run. Workspace file URLs carry that generation as a query parameter, so each
 * run gets a fresh module graph: module-level state from a previous run cannot
 * leak into the next one.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { silenceTypeStrippingWarnings } from "./dextWarnings.mjs";
import { trackWorkflowCalls } from "./dextWorkflowCalls.mjs";

// The loader runs on its own thread, which has its own warning state.
silenceTypeStrippingWarnings();

const RUNTIME_URL = new URL("./dextRuntime.mjs", import.meta.url);
const WORKSPACE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", "/index.ts", "/index.js"];
const TYPESCRIPT_EXTENSIONS = [".ts", ".mts"];

let workspaceRoot = "";
let generation = 0;
/** Directories `dext/api/<id>` resolves against, in search order. */
let apiRoots = [];

export function initialize(data) {
  workspaceRoot = typeof data?.workspaceRoot === "string" ? path.resolve(data.workspaceRoot) : "";
  generation = typeof data?.generation === "number" ? data.generation : 0;
  const configured = Array.isArray(data?.apiRoots) ? data.apiRoots.filter((root) => typeof root === "string") : [];
  apiRoots = configured.length
    ? configured.map((root) => path.resolve(root))
    : workspaceRoot ? [path.join(workspaceRoot, ".dext", "api")] : [];
}

// `--import <loader>` is the documented way to start a kernel; the kernel then
// re-registers with a per-run generation. Loader-thread instances must not
// register again, so the auto-registration is limited to the main thread.
if (isMainThread && process.env.DEXT_LOADER_AUTOREGISTER === "1") {
  nodeModule.register(import.meta.url, {
    parentURL: import.meta.url,
    data: { workspaceRoot: process.env.DEXT_WORKSPACE_ROOT ?? "", generation: 0 }
  });
}

function insideWorkspace(filePath) {
  return [workspaceRoot, ...apiRoots].filter(Boolean).some((root) => {
    const relative = path.relative(root, filePath);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

function inNodeModules(filePath) {
  return filePath.split(/[\\/]/).includes("node_modules");
}

/** Resolves an extensionless candidate the way tsserver does: exact file, then
 * a TypeScript/JavaScript extension, then a directory index. */
function resolveCandidate(candidate) {
  if (existsSync(candidate) && path.extname(candidate)) return candidate;
  for (const extension of WORKSPACE_EXTENSIONS) {
    const attempt = `${candidate}${extension}`;
    if (existsSync(attempt)) return attempt;
  }
  return undefined;
}

function apiFileUrl(specifier) {
  const id = specifier.slice("dext/api/".length);
  if (!id || id.includes("..") || path.isAbsolute(id)) {
    throw new Error(`'${specifier}' must name a file below an API directory.`);
  }
  const roots = apiRoots.length ? apiRoots : workspaceRoot ? [path.join(workspaceRoot, ".dext", "api")] : [];
  const tried = [];
  for (const root of roots) {
    const candidate = path.join(root, id);
    const file = resolveCandidate(candidate);
    if (file) return pathToFileURL(file).href;
    tried.push(candidate);
  }
  throw new Error(`Cannot find '${specifier}': no file matched ${tried.join(", ") || "any configured API directory"}.\n`);
}

function withGeneration(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") return url;
  let filePath;
  try {
    filePath = fileURLToPath(parsed);
  } catch {
    return url;
  }
  if (!insideWorkspace(filePath) || inNodeModules(filePath)) return url;
  parsed.searchParams.set("dextRun", String(generation));
  return parsed.href;
}

export async function resolve(specifier, context, next) {
  if (specifier === "dext") return { url: RUNTIME_URL.href, shortCircuit: true };
  if (specifier.startsWith("dext/api/")) {
    return { url: withGeneration(apiFileUrl(specifier)), shortCircuit: true };
  }
  const resolved = await next(specifier, context);
  return resolved.url.startsWith("file:")
    ? { ...resolved, url: withGeneration(resolved.url) }
    : resolved;
}

function filePathOf(url) {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return fileURLToPath(parsed);
}

async function transformTypescript(source, filePath, userSource) {
  const native = nodeModule.stripTypeScriptTypes;
  if (typeof native === "function") {
    return native(source, { mode: "strip", sourceUrl: filePath });
  }
  // esbuild is a development dependency: it is used only when the runtime has no
  // TypeScript support of its own. The computed specifier keeps bundlers from
  // inlining it into dist/dextLoader.mjs.
  const specifier = "esbuild";
  let transform;
  try {
    ({ transform } = await import(specifier));
  } catch {
    throw new Error(
      `This Node runtime (${process.versions.node}) cannot run TypeScript and esbuild is not installed.\n` +
      `Run Dext in a VS Code build whose Electron ships Node 22.6 or newer, or install esbuild next to the extension.\n` +
      `Source: ${userSource}`
    );
  }
  const result = await transform(source, { loader: "ts", format: "esm", target: "node20", sourcefile: filePath });
  return result.code;
}

export async function load(url, context, next) {
  if (typeof url !== "string" || !url.startsWith("file:")) return next(url, context);
  const filePath = filePathOf(url);
  const extension = path.extname(filePath);
  if (!TYPESCRIPT_EXTENSIONS.includes(extension) || inNodeModules(filePath)) return next(url, context);
  const source = await readFile(filePath, "utf8");
  let transformed;
  try {
    transformed = trackWorkflowCalls(await transformTypescript(source, filePath, filePath), generation);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "ERR_DEXT_TYPESCRIPT";
    const wrapped = new Error(`Cannot run ${filePath}: ${detail}`);
    wrapped.code = code;
    throw wrapped;
  }
  return { format: "module", source: transformed, shortCircuit: true };
}
