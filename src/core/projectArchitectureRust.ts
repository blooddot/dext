import type { ArchitectureModule, ArchitectureRelation } from "./projectArchitecture.js";
import type { SourceFileInput, LanguageScan } from "./projectArchitectureTypeScript.js";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function moduleIdFor(path: string): string {
  return normalizePath(path).replace(/\.rs$/, "");
}

function moduleFor(path: string): ArchitectureModule {
  const normalized = normalizePath(path);
  const id = moduleIdFor(path);
  return { id, name: id.split("/").at(-1) ?? id, language: "rust", paths: [normalized], source: "detected" };
}

/**
 * Removes Rust comments and string/char literals so a `use` written inside documentation, a
 * comment, or a string is never mistaken for a dependency.
 */
export function stripRustNonCode(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/r#*"[\s\S]*?"#*/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])'/g, "''")
    .replace(/\/\/[^\n]*/g, " ");
}

function candidateMatches(candidate: string, known: ReadonlySet<string>): string | undefined {
  // Trim item segments (`crate::b::Thing` -> `b`) until a scanned module matches.
  let probe = candidate;
  while (probe) {
    const matches = [...known].filter((id) =>
      id === probe
      || id.endsWith(`/${probe}`)
      || id === `src/${probe}`
      || id.endsWith(`/src/${probe}`));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
    const slash = probe.lastIndexOf("/");
    if (slash === -1) return undefined;
    probe = probe.slice(0, slash);
  }
  return undefined;
}

interface RustReference {
  target: string;
  line: number;
  kind: "use" | "mod";
  group: boolean;
}

/** Extracts `use` and `mod` references from already comment/string-stripped Rust code. */
export function extractRustReferences(code: string): RustReference[] {
  const references: RustReference[] = [];
  const lineAt = (index: number): number => code.slice(0, index).split(/\r?\n/).length;
  for (const match of code.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([^;]+);/gm)) {
    const raw = match[1]!.trim();
    const line = lineAt(match.index ?? 0);
    const grouped = raw.includes("{");
    const cleaned = raw.replace(/\{[^}]*\}/g, " ").replace(/\bas\b[^,]*$/g, "").trim();
    for (const part of cleaned.split(",")) {
      const target = part.trim().replace(/::/g, "/").replace(/\s+/g, "");
      if (target) references.push({ target, line, kind: "use", group: grouped });
    }
    if (grouped) {
      const inner = /\{([^}]*)\}/.exec(raw)?.[1];
      if (inner) {
        const prefix = cleaned.replace(/[^/]*$/, "");
        for (const part of inner.split(",")) {
          const name = part.trim().replace(/::/g, "/").replace(/\s+/g, "");
          if (name) references.push({ target: `${prefix}${name}`, line, kind: "use", group: true });
        }
      }
    }
  }
  for (const match of code.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*;/gm)) {
    references.push({ target: match[1]!, line: lineAt(match.index ?? 0), kind: "mod", group: false });
  }
  return references;
}

function resolveRustTarget(from: string, target: string): string {
  const parentOf = (id: string): string => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
  if (target.startsWith("crate/")) return target.slice("crate/".length);
  if (target.startsWith("self/")) return `${from}${target.slice("self/".length)}`;
  if (target.startsWith("super/")) {
    let base = from;
    let rest = target;
    while (rest.startsWith("super/")) {
      base = parentOf(base);
      rest = rest.slice("super/".length);
    }
    return `${base}/${rest}`;
  }
  return target;
}

export interface CargoPackageMetadata {
  name?: string;
  version?: string;
  description?: string;
  dependencies: string[];
}

/** Reads the description and dependency names a Cargo manifest declares, without running Cargo. */
export function parseCargoManifest(content: string): CargoPackageMetadata {
  const metadata: CargoPackageMetadata = { dependencies: [] };
  let section = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1]!.trim(); continue; }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const key = assignment[1]!;
    const value = assignment[2]!.replace(/^"|"$/g, "");
    if (section === "package") {
      if (key === "name") metadata.name = value;
      if (key === "version") metadata.version = value;
      if (key === "description") metadata.description = value;
    }
    if ((section === "dependencies" || section.endsWith(".dependencies") || section === "dev-dependencies" || section.endsWith(".dev-dependencies") || section === "build-dependencies" || section.endsWith(".build-dependencies")) && !metadata.dependencies.includes(key)) {
      metadata.dependencies.push(key);
    }
  }
  return metadata;
}

export interface RustProjectMetadata {
  packages: Array<{ path: string; metadata: CargoPackageMetadata }>;
  /** True when Cargo.toml was readable. An external `cargo metadata` call is never required. */
  available: boolean;
  coverage: string[];
}

export function scanRustProjectMetadata(files: readonly SourceFileInput[]): RustProjectMetadata {
  const packages: RustProjectMetadata["packages"] = [];
  const coverage: string[] = [];
  for (const file of files) {
    const name = normalizePath(file.path);
    if (name === "Cargo.toml" || name.endsWith("/Cargo.toml")) packages.push({ path: name, metadata: parseCargoManifest(file.content) });
    if (name.endsWith("Cargo.lock")) coverage.push("Cargo.lock was not resolved; dependency versions come from the manifest only.");
  }
  return { packages, available: packages.length > 0, coverage };
}

export interface CargoMetadataJson {
  packages?: Array<{ name?: string; version?: string; description?: string; dependencies?: Array<{ name?: string }> }>;
}

/**
 * Enriches manifest metadata with an optional `cargo metadata` result. The external process uses
 * the caller's existing permissions; when it is unavailable the manifest data is kept and the
 * reduced coverage is reported instead of failing the scan.
 */
export async function readRustProjectMetadata(
  files: readonly SourceFileInput[],
  options: { runCargoMetadata?: (manifestPath: string) => Promise<CargoMetadataJson | undefined> } = {}
): Promise<RustProjectMetadata> {
  const base = scanRustProjectMetadata(files);
  if (!options.runCargoMetadata || !base.packages.length) return base;
  const coverage = [...base.coverage];
  const packages: RustProjectMetadata["packages"] = [];
  for (const entry of base.packages) {
    try {
      const json = await options.runCargoMetadata(entry.path);
      const resolved = json?.packages?.[0];
      if (!resolved) {
        coverage.push(`cargo metadata returned no package for ${entry.path}; using the manifest only.`);
        packages.push(entry);
        continue;
      }
      packages.push({
        path: entry.path,
        metadata: {
          ...entry.metadata,
          ...(resolved.name ? { name: resolved.name } : {}),
          ...(resolved.version ? { version: resolved.version } : {}),
          ...(resolved.description ? { description: resolved.description } : {}),
          dependencies: resolved.dependencies?.map((dependency) => dependency.name).filter((name): name is string => Boolean(name)) ?? entry.metadata.dependencies
        }
      });
    } catch {
      coverage.push(`cargo metadata was unavailable for ${entry.path}; using the manifest only.`);
      packages.push(entry);
    }
  }
  return { packages, available: base.available, coverage };
}

/**
 * Scans Rust sources for module-tree and `use` relations. Comments, documentation, and string
 * literals are stripped first, and any construct that needs macro expansion or conditional
 * compilation is reported as uncertain rather than assumed.
 */
export interface RustScanOptions {
  /**
   * Crates declared by a Cargo manifest. A local `use <crate>::x` stays an internal edge, and the
   * crate root is the `src/lib.rs` or `src/main.rs` beside that manifest.
   */
  crates?: readonly { name: string; manifestPath: string }[];
}
export function scanRust(files: readonly SourceFileInput[], options: RustScanOptions = {}): LanguageScan {
  const modules = files.map((file) => moduleFor(file.path));
  const known = new Set(modules.map((module) => module.id));
  // A `use <crate>::x` that names a local package is an internal edge, not an external dependency.
  const crateRoots = new Map<string, string>();
  for (const crate of options.crates ?? []) {
    const dir = normalizePath(crate.manifestPath).replace(/\/?Cargo\.toml$/, "");
    const candidates = dir ? [`${dir}/src/lib`, `${dir}/src/main`] : ["src/lib", "src/main"];
    const root = candidates.find((candidate) => known.has(candidate));
    if (root) crateRoots.set(crate.name, root);
  }
  const relations: ArchitectureRelation[] = [];
  const unsupported: { path: string; reason: string }[] = [];
  for (const file of files) {
    const from = moduleIdFor(file.path);
    const code = stripRustNonCode(file.content);
    for (const reference of extractRustReferences(code)) {
      const [head, ...rest] = reference.target.split("/");
      const crateRoot = head ? crateRoots.get(head) : undefined;
      const target = crateRoot ? [crateRoot, ...rest].filter(Boolean).join("/") : resolveRustTarget(from, reference.target);
      const to = candidateMatches(target, known);
      if (to && to !== from) {
        relations.push({ from, to, source: "detected", confidence: reference.kind === "mod" ? 0.95 : 0.85, file: file.path, line: reference.line });
        continue;
      }
      if (to === from) continue;
      unsupported.push({ path: file.path, reason: `Rust path '${reference.target}' could not be resolved without macro expansion.` });
    }
    if (/\b(?:macro_rules|include|include_str|include_bytes)!/.test(code) || /#\[cfg\b/.test(code)) unsupported.push({ path: file.path, reason: "Conditional compilation, macros, or generated includes are only partially covered." });
  }
  return { modules, relations, unsupported, parserVersion: "rust-source-conservative" };
}
