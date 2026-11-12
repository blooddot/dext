import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Whether `candidate` stays inside `root`. Pure path arithmetic, so a symlink
 * inside the root can still point outside; use `insideRealRoot` for that. */
export function insideRoot(
  root: string,
  candidate: string,
  { allowRoot = true }: { allowRoot?: boolean } = {}
): boolean {
  const part = relative(resolve(root), resolve(candidate));
  if (part === "") return allowRoot;
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

/** The same boundary, resolved through symlinks. Missing paths are resolved
 * through their existing ancestors, which may themselves be symlinks. */
export async function insideRealRoot(
  root: string,
  candidate: string,
  options: { allowRoot?: boolean } = {}
): Promise<boolean> {
  return insideRoot(await realOrResolve(root), await realOrResolve(candidate), options);
}

async function realOrResolve(path: string): Promise<string> {
  // Keep the platform's native realpath semantics (including symlink/.. paths)
  // whenever the target exists. Only reconstruct a missing path from its
  // existing ancestors so a symlinked workspace remains canonical on every OS.
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const absolute = resolve(path);
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(await realOrResolve(parent), basename(absolute));
  }
}
