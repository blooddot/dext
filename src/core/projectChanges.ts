import { createHash } from "node:crypto";

export interface ProjectFileBaseline {
  path: string;
  contentHash: string;
  exists: boolean;
}

export interface ProjectChange {
  path: string;
  kind: "created" | "modified" | "deleted" | "unchanged" | "unknown";
  baselineHash?: string;
  currentHash?: string;
}

export function hashProjectContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function compareProjectBaselines(
  baseline: readonly ProjectFileBaseline[],
  current: readonly ProjectFileBaseline[]
): ProjectChange[] {
  const before = new Map(baseline.map((item) => [item.path.replaceAll("\\", "/"), item]));
  const after = new Map(current.map((item) => [item.path.replaceAll("\\", "/"), item]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.map((path) => {
    const oldFile = before.get(path);
    const newFile = after.get(path);
    if (!oldFile || !oldFile.exists) return newFile?.exists
      ? { path, kind: "created", ...(newFile.contentHash ? { currentHash: newFile.contentHash } : {}) }
      : { path, kind: "unknown" };
    if (!newFile || !newFile.exists) return { path, kind: "deleted", baselineHash: oldFile.contentHash };
    if (oldFile.contentHash !== newFile.contentHash) return { path, kind: "modified", baselineHash: oldFile.contentHash, currentHash: newFile.contentHash };
    return { path, kind: "unchanged", baselineHash: oldFile.contentHash, currentHash: newFile.contentHash };
  });
}
