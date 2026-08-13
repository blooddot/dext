export function parseUriList(value: string): string[] {
  return [...new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
  )];
}

function isAbsoluteUri(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/{1,2}[^\s]+$/.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validUriList(value: string): string[] {
  return parseUriList(value).filter(isAbsoluteUri);
}

function parseJsonStringArray(value: string): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((item) => typeof item === "string")) {
      return [];
    }
    return [...new Set(parsed)];
  } catch {
    return [];
  }
}

export interface DroppedUriPayload {
  uriList: string;
  codeUriList: string;
  resourceUrls: string;
  codeFiles: string;
  plainText: string;
}

export interface DroppedFileItem {
  kind: "uri" | "path";
  value: string;
}

function uriItems(values: readonly string[]): DroppedFileItem[] {
  return values.map((value) => ({ kind: "uri", value }));
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(value);
}

export function parseDroppedFiles(payload: DroppedUriPayload): DroppedFileItem[] {
  for (const candidate of [payload.uriList, payload.codeUriList]) {
    const uris = validUriList(candidate);
    if (uris.length) return uriItems(uris);
  }
  const resourceUrls = parseJsonStringArray(payload.resourceUrls);
  if (resourceUrls.length && resourceUrls.every(isAbsoluteUri)) return uriItems(resourceUrls);
  const codeFiles = parseJsonStringArray(payload.codeFiles);
  if (codeFiles.length && codeFiles.every(isAbsoluteLocalPath)) {
    return codeFiles.map((value) => ({ kind: "path", value }));
  }
  const fallback = parseUriList(payload.plainText);
  return fallback.length > 0 && fallback.every(isAbsoluteUri) ? uriItems(fallback) : [];
}
