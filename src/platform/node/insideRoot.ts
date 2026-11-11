import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

/** The same boundary, resolved through symlinks. A path that does not exist
 * cannot escape through a link, so `resolve` is enough for it. */
export async function insideRealRoot(
  root: string,
  candidate: string,
  options: { allowRoot?: boolean } = {}
): Promise<boolean> {
  return insideRoot(await realOrResolve(root), await realOrResolve(candidate), options);
}

async function realOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}
