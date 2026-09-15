import type { ArchitectureScanResult, ProjectLanguage } from "./projectArchitecture.js";
import { scanTypeScript, type SourceFileInput } from "./projectArchitectureTypeScript.js";
import { scanPython } from "./projectArchitecturePython.js";
import { scanRust, scanRustProjectMetadata } from "./projectArchitectureRust.js";

export interface ArchitectureScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
  /** Absolute deadline in epoch milliseconds; scanning stops once it passes. */
  deadline?: number;
}

function languageFor(path: string): ProjectLanguage {
  if (/\.[cm]?[jt]sx?$/.test(path)) return "typescript";
  if (/\.py$/.test(path)) return "python";
  if (/\.rs$/.test(path)) return "rust";
  return "unknown";
}

/** A manifest is context for the scan rather than a source file, so it never reports as unknown. */
function isProjectManifest(path: string): boolean {
  return /(?:^|\/)(?:Cargo\.toml|Cargo\.lock|package\.json|pyproject\.toml|tsconfig\.json)$/.test(path);
}

export function scanProjectArchitecture(files: readonly SourceFileInput[], options: ArchitectureScanOptions = {}): ArchitectureScanResult {
  const maxFiles = options.maxFiles ?? 10_000;
  const maxFileBytes = options.maxFileBytes ?? 2_000_000;
  const selected = files.slice(0, maxFiles).filter((file) => Buffer.byteLength(file.content, "utf8") <= maxFileBytes);
  const unsupported = files.slice(maxFiles).map((file) => ({ path: file.path, reason: "File limit exceeded." }));
  for (const file of files.slice(0, maxFiles)) {
    if (Buffer.byteLength(file.content, "utf8") > maxFileBytes) unsupported.push({ path: file.path, reason: "File size limit exceeded." });
  }
  const groups = new Map<ProjectLanguage, SourceFileInput[]>();
  let timedOut = false;
  for (const file of selected) {
    if (options.signal?.aborted) break;
    if (options.deadline !== undefined && Date.now() > options.deadline) { timedOut = true; break; }
    const language = languageFor(file.path);
    if (language !== "unknown") groups.set(language, [...(groups.get(language) ?? []), file]);
    else if (!isProjectManifest(file.path)) unsupported.push({ path: file.path, reason: "Unsupported language." });
  }
  if (timedOut) unsupported.push({ path: "*", reason: "Scan time limit exceeded." });
  // Cargo manifests are read without running Cargo, so the package name resolves local crate paths
  // and any reduced coverage is reported instead of being silently assumed.
  const rustMetadata = scanRustProjectMetadata(selected);
  const crates = rustMetadata.packages.flatMap((entry) =>
    entry.metadata.name ? [{ name: entry.metadata.name, manifestPath: entry.path }] : []);
  const scans = [
    groups.get("typescript") ? scanTypeScript(groups.get("typescript")!) : undefined,
    groups.get("python") ? scanPython(groups.get("python")!) : undefined,
    groups.get("rust") ? scanRust(groups.get("rust")!, { crates }) : undefined,
  ].filter((scan): scan is NonNullable<typeof scan> => Boolean(scan));
  return {
    modules: scans.flatMap((scan) => scan.modules),
    relations: scans.flatMap((scan) => scan.relations),
    unsupported: [...unsupported, ...scans.flatMap((scan) => scan.unsupported)],
    parserVersions: Object.fromEntries(scans.map((scan) => [scan.modules[0]?.language ?? "unknown", scan.parserVersion])) as ArchitectureScanResult["parserVersions"],
    ...(rustMetadata.coverage.length ? { coverage: [...rustMetadata.coverage] } : {})
  };
}
