import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const REPAIR_FILE_LIMIT = 128 * 1024;
const DIFF_LIMIT = 24 * 1024;

export interface RepairDelta {
  path: string;
  after: string;
  hunks: string;
}

// An absent path in the initial dirty-file snapshot has its HEAD contents.
export async function cleanFile(head: string, path: string): Promise<Buffer | undefined> {
  if (!head) return Buffer.alloc(0);
  try {
    const { stdout } = await exec("git", ["--literal-pathspecs", "ls-tree", "-z", head, "--", path], { timeout: 5000 });
    if (!stdout) return Buffer.alloc(0);
    const blob = await exec("git", ["cat-file", "blob", `${head}:${path}`], { encoding: "buffer", maxBuffer: REPAIR_FILE_LIMIT, timeout: 5000 });
    return blob.stdout;
  } catch {
    return undefined;
  }
}

export async function repairHunks(before: Buffer | undefined, after: Buffer | undefined): Promise<string> {
  if (!before || !after || before.includes(0) || after.includes(0) || before.equals(after)) return "";
  const directory = await mkdtemp(join(tmpdir(), "dext-review-diff-"));
  const left = join(directory, "before");
  const right = join(directory, "after");
  try {
    await Promise.all([writeFile(left, before), writeFile(right, after)]);
    await exec("git", ["--no-pager", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", "--", left, right], { maxBuffer: DIFF_LIMIT, timeout: 5000 });
    return "";
  } catch (error) {
    const result = error as { code?: number; stdout?: string };
    const start = result.stdout?.indexOf("\n@@ ") ?? -1;
    return result.code === 1 && start >= 0 ? result.stdout!.slice(start + 1).trimEnd() : "";
  } finally {
    await Promise.all([rm(left, { force: true }), rm(right, { force: true })]);
    await rmdir(directory);
  }
}

export function readRepairDeltas(value: unknown): RepairDelta[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is RepairDelta => typeof entry?.path === "string" && typeof entry.after === "string"
    && typeof entry.hunks === "string" && Boolean(entry.path) && Boolean(entry.hunks));
}

export function hasRepairAnchor(delta: RepairDelta, line: number): boolean {
  for (const hunk of delta.hunks.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0 ? line === start || line === start + 1 : line >= start && line < start + count) return true;
  }
  return false;
}
