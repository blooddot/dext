/** Naming and path rules for saved Plan documents. Kept free of VS Code so the
 * host and the tests agree on exactly one definition of a legal plan path. */

export const DEFAULT_PLAN_DIRECTORY = ".dext/plans";

/** The goal becomes the file name, so it is reduced to the characters that are
 * safe on every platform Dext runs on. */
export function planSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "plan";
}

export function planTimestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("");
  const time = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("");
  return `${date}-${time}`;
}

export function planFileName(input: string, now: Date): string {
  return `${planTimestamp(now)}-${planSlug(input)}.plan.md`;
}

/** Splits a workspace-relative directory or file path into segments, rejecting
 * anything that could escape the workspace. Both the plan directory setting and
 * the `buildPlan` request from the webview go through here. */
export function planPathSegments(path: string): string[] {
  const segments = path
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== ".");
  if (!segments.length) throw new Error("A plan path must name at least one segment.");
  if (segments.includes("..")) throw new Error("A plan path must stay inside the workspace.");
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error("A plan path must be relative to the workspace.");
  }
  return segments;
}
