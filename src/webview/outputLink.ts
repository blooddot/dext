const DEXT_RANGE_FRAGMENT = /#L\d+,\d+-L\d+,\d+$/;

/**
 * Converts a Markdown link destination into the workspace-relative reference
 * understood by the extension host. Web links deliberately stay in the
 * browser, while `file:` URLs can be validated by the host before opening.
 */
export function outputLinkReference(href: string): string | undefined {
  const value = href.trim();
  if (!value || value.startsWith("#")) return undefined;
  if (value.toLowerCase().startsWith("file:")) return value;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith("//")) return undefined;

  const hash = value.indexOf("#");
  const path = value.slice(0, hash < 0 ? value.length : hash).split("?", 1)[0] ?? "";
  const fragment = hash < 0 ? "" : value.slice(hash);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path).replaceAll("\\", "/");
  } catch {
    return undefined;
  }
  const normalized = decoded.replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return undefined;
  if (normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  // A normal Markdown heading is not a text range. It should still open the
  // linked file, while Dext's explicit source range remains intact.
  return `${normalized}${DEXT_RANGE_FRAGMENT.test(fragment) ? fragment : ""}`;
}
