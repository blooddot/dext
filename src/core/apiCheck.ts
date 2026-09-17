import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { BUILTIN_METHODS } from "./builtins.js";
import { loadCustomApis } from "./customApi.js";
import type { DextDiagnostic } from "./apiDiagnostic.js";
import { apiRuleDiagnostics } from "./apiRuleDiagnostics.js";
import { parseMcpManifest } from "./mcpManifest.js";
import { MethodRegistry } from "./registry.js";

export interface ApiCheckOptions {
  workspace: string;
  apiDirs?: readonly string[];
  globalStorage?: string;
  /** Editor buffers override disk, and can include new unsaved files. */
  documents?: ReadonlyMap<string, string>;
  /** VS Code supplies its already resolved configuration. */
  readSettings?: boolean;
}

export interface ApiCheckResult {
  files: string[];
  diagnostics: DextDiagnostic[];
  errors: number;
  warnings: number;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function within(root: string, path: string): boolean {
  const name = relative(root, path);
  return name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

export async function checkApis(options: ApiCheckOptions): Promise<ApiCheckResult> {
  const workspace = resolve(options.workspace);
  if (!(await stat(workspace)).isDirectory()) throw new Error(`Not a workspace directory: ${workspace}`);
  const diagnostics: DextDiagnostic[] = [];
  const files = new Set<string>();
  const documents = new Map([...options.documents ?? []].map(([path, content]) => [resolve(path), content]));
  const read = async (path: string): Promise<string | undefined> => {
    if (documents.has(resolve(path))) return documents.get(resolve(path));
    try { return await readFile(path, "utf8"); } catch (error) { if (missing(error)) return undefined; throw error; }
  };
  const report = (path: string, message: string, code: string, from = 0, to = from + 1): void => {
    diagnostics.push({ path, message, code, severity: "error", from, to });
  };
  const configured: string[] = [];
  if (options.readSettings !== false) {
    const path = join(workspace, ".vscode", "settings.json");
    const content = await read(path);
    if (content !== undefined) {
      const errors: ParseError[] = [];
      const settings: unknown = parse(content, errors, { allowTrailingComma: true });
      for (const error of errors) report(path, "Invalid workspace settings JSONC.", "dext/config", error.offset, error.offset + error.length);
      const dirs: unknown = settings && typeof settings === "object" ? (settings as Record<string, unknown>)["dext.apiDirs"] : undefined;
      if (dirs !== undefined) {
        if (Array.isArray(dirs) && dirs.every((value): value is string => typeof value === "string")) configured.push(...dirs);
        else report(path, "dext.apiDirs must be an array of paths.", "dext/config");
      }
    }
  }
  const roots = [...new Set([
    join(workspace, ".dext", "api"),
    ...(options.globalStorage ? [resolve(options.globalStorage, "api")] : []),
    ...configured.concat([...(options.apiDirs ?? [])]).filter((path) => path.trim()).map((path) => resolve(workspace, path.trim()))
  ])];
  const registry = new MethodRegistry();
  registry.registerMany(BUILTIN_METHODS, "builtin");
  const servers = new Set<string>();
  for (const root of [join(workspace, ".dext", "mcp"), ...(options.globalStorage ? [resolve(options.globalStorage, "mcp")] : [])]) {
    try {
      let names: string[];
      try { names = await readdir(root); } catch (error) { if (missing(error)) continue; throw error; }
      for (const name of names.sort().filter((name) => name.toLowerCase().endsWith(".jsonc"))) {
        const path = join(root, name);
        try {
          const manifest = parseMcpManifest(await read(path) ?? "", path);
          if (manifest.server && servers.has(manifest.server.name)) continue;
          if (manifest.server) servers.add(manifest.server.name);
          for (const message of manifest.diagnostics) report(path, message, "dext/mcp");
          registry.registerMany(manifest.methods, "project");
        } catch (error) { report(path, String(error), "dext/read"); }
      }
    } catch (error) { report(root, String(error), "dext/read"); }
  }
  const list = async (root: string): Promise<string[]> => {
    const paths = new Set<string>();
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (missing(error)) return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && path.toLowerCase().endsWith(".dx")) paths.add(path);
      }
    };
    await visit(root);
    for (const path of documents.keys()) if (path.toLowerCase().endsWith(".dx") && within(root, path)) paths.add(path);
    for (const path of paths) files.add(path);
    return [...paths].sort();
  };
  const loaded = await loadCustomApis(true, roots, list, read, registry);
  diagnostics.push(...loaded.diagnosticDetails);
  const ruleRoots = [join(workspace, ".dext", "rules"), ...(options.globalStorage ? [resolve(options.globalStorage, "rules")] : [])];
  diagnostics.push(...await apiRuleDiagnostics(loaded.files, registry, async (name) => {
    // A rule that escapes the rules directory is a different problem from one
    // that is simply not there, so they carry different stable codes.
    if (!name || isAbsolute(name) || /^[A-Za-z]:|^[\\/]/.test(name) || name.split(/[\\/]/).includes("..")) return { code: "dext/rule", message: `Rule '${name}' must stay below .dext/rules.` };
    for (const root of ruleRoots) {
      const path = resolve(root, name);
      if (!within(root, path)) return { code: "dext/rule", message: `Rule '${name}' must stay below .dext/rules.` };
      try { if (await read(path) !== undefined) return undefined; } catch (error) { return { code: "dext/rule", message: `Cannot read rule '${name}': ${String(error)}` }; }
    }
    return { code: "dext/missing-rule", message: `Rule '${name}' was not found in .dext/rules${options.globalStorage ? " or global rules" : ""}.` };
  }));
  diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from || a.code.localeCompare(b.code));
  return { files: [...files].sort(), diagnostics, errors: diagnostics.filter((item) => item.severity === "error").length, warnings: diagnostics.filter((item) => item.severity === "warning").length };
}
