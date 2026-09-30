import { readFile } from "node:fs/promises";

/**
 * The Node and JavaScript API reference the APIs page lists.
 *
 * The catalog is generated from declaration files rather than maintained by hand
 * (`scripts/generateApiReference.mjs`), so every signature is the one the editor
 * and the kernel resolve and every description is the JSDoc the declaration
 * carries. It ships as `dist/api-reference.json` and is read lazily: a workspace
 * without the build artifact simply shows the callable APIs and nothing else.
 */

/** How a member is grouped and labelled. A function and a method are both
 * callable, and an interface, type and enum are all types. */
export type ApiReferenceKind =
  | "function"
  | "method"
  | "class"
  | "constructor"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "variable";

export interface ApiReferenceParam {
  name: string;
  text: string;
}

export interface ApiReferenceMember {
  name: string;
  kind: ApiReferenceKind;
  /** The declaration's own signature, one line per overload. */
  signature: string;
  documentation?: string;
  deprecated?: string;
  returns?: string;
  example?: string;
  params?: readonly ApiReferenceParam[];
  members?: readonly ApiReferenceMember[];
}

export interface ApiReferenceModule {
  /** The specifier of a Node module (`node:fs/promises`), or `js.<global>`. */
  id: string;
  family: "node" | "js";
  /** The short name the tree shows: `fs/promises`, `JSON`. */
  name: string;
  documentation?: string;
  members: readonly ApiReferenceMember[];
}

export interface ApiReferenceCatalog {
  version: number;
  typescript: string;
  modules: readonly ApiReferenceModule[];
}

/** The catalog format this reader understands; a newer build is not parsed. */
export const API_REFERENCE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KINDS = new Set<string>([
  "function", "method", "class", "constructor", "interface", "type", "enum", "namespace", "variable"
]);

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseParam(value: unknown): ApiReferenceParam | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.text !== "string") return undefined;
  return { name: value.name, text: value.text };
}

function parseMember(value: unknown): ApiReferenceMember | undefined {
  if (!isRecord(value)) return undefined;
  const { name, kind, signature } = value;
  if (typeof name !== "string" || !name || typeof kind !== "string" || !KINDS.has(kind)) return undefined;
  if (typeof signature !== "string" || !signature) return undefined;
  const params = Array.isArray(value.params)
    ? value.params.map(parseParam).filter((param): param is ApiReferenceParam => param !== undefined)
    : [];
  const members = Array.isArray(value.members)
    ? value.members.map(parseMember).filter((member): member is ApiReferenceMember => member !== undefined)
    : [];
  return {
    name,
    kind: kind as ApiReferenceKind,
    signature,
    ...(optionalText(value.documentation) ? { documentation: value.documentation as string } : {}),
    ...(optionalText(value.deprecated) ? { deprecated: value.deprecated as string } : {}),
    ...(optionalText(value.returns) ? { returns: value.returns as string } : {}),
    ...(optionalText(value.example) ? { example: value.example as string } : {}),
    ...(params.length ? { params } : {}),
    ...(members.length ? { members } : {})
  };
}

function parseModule(value: unknown): ApiReferenceModule | undefined {
  if (!isRecord(value)) return undefined;
  const { id, family, name } = value;
  if (typeof id !== "string" || !id || (family !== "node" && family !== "js")) return undefined;
  if (typeof name !== "string" || !name) return undefined;
  if (!Array.isArray(value.members) || !value.members.length) return undefined;
  const members = value.members.map(parseMember).filter((member): member is ApiReferenceMember => member !== undefined);
  if (!members.length) return undefined;
  return {
    id,
    family,
    name,
    ...(optionalText(value.documentation) ? { documentation: value.documentation as string } : {}),
    members
  };
}

/** Parses the shipped catalog. A malformed or future file reads as absent rather
 * than as a half-populated reference. */
export function parseApiReference(text: string): ApiReferenceCatalog | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== API_REFERENCE_VERSION || !Array.isArray(value.modules)) return undefined;
  const modules = value.modules.map(parseModule).filter((module): module is ApiReferenceModule => module !== undefined);
  if (!modules.length) return undefined;
  return {
    version: API_REFERENCE_VERSION,
    typescript: typeof value.typescript === "string" ? value.typescript : "",
    modules
  };
}

/** Reads the catalog a build wrote. A missing file is not an error: the page
 * falls back to the callable APIs alone. */
export async function loadApiReference(file: string): Promise<ApiReferenceCatalog | undefined> {
  try {
    return parseApiReference(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** A lazy, cached reader for the catalog, so a page render does not read and
 * parse several megabytes more than once. */
export function createApiReferenceSource(file: string): () => Promise<ApiReferenceCatalog | undefined> {
  let cached: ApiReferenceCatalog | undefined;
  let pending: Promise<ApiReferenceCatalog | undefined> | undefined;
  return () => {
    if (cached) return Promise.resolve(cached);
    pending ??= loadApiReference(file).then((catalog) => {
      // A failure is not cached: a build that lands later is picked up on the
      // next reload instead of leaving the page permanently empty.
      if (catalog) cached = catalog;
      else pending = undefined;
      return catalog;
    });
    return pending;
  };
}
