import { execFile } from "node:child_process";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const exec = promisify(execFile);
const GIT_OPTIONS = { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 } as const;

async function moduleSourcePaths(root: string, scope: string[], pathspecs: readonly string[]): Promise<string[]> {
  try {
    const { stdout } = await exec("git", [
      "grep", ...scope, "--no-color", "-I", "-l", "-z", "-E", "-e", "import|export|require", "--", ...pathspecs
    ], { ...GIT_OPTIONS, cwd: root });
    return stdout.split("\0").filter(Boolean);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}

function moduleResolver(root: string, targets: ReadonlySet<string>) {
  function canonical(path: string) {
    const absolute = resolve(root, path);
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  }
  const targetPaths = new Set([...targets].map(canonical));
  const configFiles = new Map<string, string | undefined>();
  const configs = new Map<string | undefined, { options: ts.CompilerOptions; cache: ts.ModuleResolutionCache }>();
  const host = { ...ts.sys, fileExists: (path: string) => targetPaths.has(canonical(path)) || ts.sys.fileExists(path) };

  function insideWorkspace(path: string) {
    const fromRoot = relative(root, path);
    return fromRoot !== ".." && !fromRoot.startsWith("../") && !fromRoot.startsWith("..\\") && !isAbsolute(fromRoot);
  }

  return (source: string, path: string) => {
    const file = resolve(root, path);
    const folder = dirname(file);
    if (!configFiles.has(folder)) {
      const exists = (config: string) => insideWorkspace(config) && ts.sys.fileExists(config);
      configFiles.set(folder, ts.findConfigFile(folder, exists) ?? ts.findConfigFile(folder, exists, "jsconfig.json"));
    }
    const config = configFiles.get(folder);
    let parsed = configs.get(config);
    if (!parsed) {
      const options = (config ? ts.getParsedCommandLineOfConfigFile(config, {}, {
        ...ts.sys, readDirectory: () => [], onUnRecoverableConfigFileDiagnostic: () => undefined
      })?.options : undefined) ?? { moduleResolution: ts.ModuleResolutionKind.Node10 };
      parsed = { options, cache: ts.createModuleResolutionCache(root, canonical, options) };
      configs.set(config, parsed);
    }
    return ts.preProcessFile(source, true, true).importedFiles.some(({ fileName }) => {
      const { resolvedModule } = ts.resolveModuleName(fileName, file, parsed.options, host, parsed.cache);
      if (resolvedModule) return targetPaths.has(canonical(resolvedModule.resolvedFileName));
      return fileName.startsWith(".") && extname(fileName) === ".vue" && targetPaths.has(canonical(resolve(folder, fileName)));
    });
  };
}

/** Resolve imports against their own source files and project config, using
 * both worktree and staged text when the two versions can differ. */
export async function reverseModuleDeps(
  root: string, targets: ReadonlySet<string>, changedFiles: ReadonlySet<string>, pathspecs: readonly string[]
): Promise<string[]> {
  if (!targets.size) return [];
  const [tracked, local, staged] = await Promise.all([
    moduleSourcePaths(root, [], pathspecs),
    moduleSourcePaths(root, ["--no-recurse-submodules", "--untracked"], pathspecs),
    moduleSourcePaths(root, ["--cached"], pathspecs)
  ]);
  const worktree = new Set([...tracked, ...local]);
  const index = new Set(staged);
  const referencesTarget = moduleResolver(root, targets);
  const callers: string[] = [];
  for (const path of new Set([...worktree, ...index])) {
    if (targets.has(path)) continue;
    if (worktree.has(path) && referencesTarget(ts.sys.readFile(resolve(root, path)) ?? "", path)) {
      callers.push(path);
      continue;
    }
    if (index.has(path) && changedFiles.has(path)) {
      const { stdout } = await exec("git", ["show", `:${path}`], { ...GIT_OPTIONS, cwd: root });
      if (referencesTarget(stdout, path)) callers.push(path);
    }
  }
  return callers;
}
