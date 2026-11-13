import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** A path that climbs with `..`, where Windows and POSIX disagree: Windows
 * collapses the segment before it touches the filesystem, POSIX resolves the
 * link first and then climbs from the link's target. */
const climbsParent = /(^|[\\/])\.\.([\\/]|$)/;

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
  // One `realpath` call is enough when nothing climbs a parent: it canonicalizes
  // every existing segment and reports the first missing one.
  if (!climbsParent.test(path)) {
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return resolveSegmentBySegment(path);
}

function asAbsolute(path: string): string {
  return isAbsolute(path) ? path : `${resolve(".")}${sep}${path}`;
}

/** Resolve one segment at a time so `..` always climbs from the resolved link
 * target, and so a missing segment is rebuilt on top of a real ancestor. */
async function resolveSegmentBySegment(path: string): Promise<string> {
  const absolute = asAbsolute(path);
  const { root } = parse(absolute);
  let resolved = root;
  const missing: string[] = [];
  for (const segment of absolute.slice(root.length).split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (missing.length > 0) missing.pop();
      else resolved = dirname(resolved);
      continue;
    }
    // Nothing below a missing segment can exist, so the rest is plain spelling.
    if (missing.length > 0) {
      missing.push(segment);
      continue;
    }
    try {
      resolved = await realpath(join(resolved, segment));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(segment);
    }
  }
  return missing.length > 0 ? join(resolved, ...missing) : resolved;
}
